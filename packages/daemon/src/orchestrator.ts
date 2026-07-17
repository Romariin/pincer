import {
  PROTOCOL_VERSION,
  DEFAULT_EFFORT,
  type AgentTask,
  type ConversationConfig,
  type ConversationSummary,
  type DiffHunk,
  type DomContext,
  type HarnessAvailability,
  type MessageBlock,
  type PromptElement,
  type ServerMessage,
  type SourceLocation,
  type TurnSummary,
} from "@pincer/core";
import type { Git } from "./git";
import type { ResolvedHarness } from "./agents/registry";
import type { ConversationRow, Store, TurnRow } from "./store";

export type Emit = (msg: ServerMessage) => void;

export interface OrchestratorDeps {
  git: Git;
  store: Store;
  projectRoot: string;
  harnesses: ResolvedHarness[];
  log?: (msg: string) => void;
}

interface ActiveTurn {
  conversationId: string;
  turnId: number;
  proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">;
  cancelled: boolean;
}

const NO_AGENT_HINT =
  "No coding harness detected. Install Claude Code, Codex, or OMP, or configure one via pincer.config.json.";
const MAX_DIFF_FILES = 8;
const MAX_DIFF_LINES = 240;

/** Composes store + harnesses to run direct-edit turns: the chosen harness edits the working tree in place. */
export class Orchestrator {
  private readonly git: Git;
  private readonly store: Store;
  private readonly projectRoot: string;
  private readonly harnesses: ResolvedHarness[];
  private readonly log: (msg: string) => void;

  private activeConversationId: string | null = null;
  private activeTurn: ActiveTurn | null = null;

  constructor(deps: OrchestratorDeps) {
    this.git = deps.git;
    this.store = deps.store;
    this.projectRoot = deps.projectRoot;
    this.harnesses = deps.harnesses;
    this.log = deps.log ?? (() => {});
  }

  /** Default harness id for new conversations (first detected), or null. */
  get defaultHarnessId(): string | null {
    return this.harnesses.find((h) => h.detected)?.adapter.id ?? null;
  }

  /** Back-compat alias used by the CLI banner. */
  get agentId(): string | null {
    return this.defaultHarnessId;
  }

  harnessAvailability(): HarnessAvailability[] {
    return this.harnesses.map((h) => ({ ...h.adapter.info, models: h.models, detected: h.detected }));
  }

  private harnessFor(id: string): ResolvedHarness | undefined {
    return (
      this.harnesses.find((h) => h.adapter.id === id) ??
      this.harnesses.find((h) => h.adapter.id === this.defaultHarnessId) ??
      this.harnesses.find((h) => h.detected)
    );
  }

  listConversations(): ServerMessage {
    return { v: PROTOCOL_VERSION, type: "conversations", items: this.store.listConversations() };
  }

  async newConversation(config: ConversationConfig): Promise<ServerMessage> {
    // Direct-edit mode: no pincer branch, no clean-tree gate. The chosen harness
    // edits the working tree in place on whatever branch is currently checked out.
    const id = crypto.randomUUID().slice(0, 8);
    const branch = await this.git.currentBranch();

    const harness = this.harnessFor(config.harnessId ?? this.defaultHarnessId ?? "");
    const harnessId = config.harnessId ?? harness?.adapter.id ?? this.defaultHarnessId ?? "";
    const model = config.model ?? harness?.adapter.info.defaultModel ?? "";
    const effort = config.effort ?? DEFAULT_EFFORT;

    const now = Date.now();
    this.store.createConversation({
      id,
      branch,
      base_branch: branch,
      base_commit: "",
      status: "active",
      agent_id: harnessId || "none",
      harness_id: harnessId,
      model,
      effort,
      created_at: now,
      updated_at: now,
    });
    this.activeConversationId = id;

    const row = this.store.getConversation(id);
    if (!row) throw new Error("conversation vanished after creation");
    return { v: PROTOCOL_VERSION, type: "conversation_started", conversation: this.toSummary(row) };
  }

  async resumeConversation(id: string): Promise<ServerMessage> {
    const conv = this.store.getConversation(id);
    if (!conv) return this.unknownConversation();
    this.activeConversationId = id;
    const turns = this.store.getTurns(id).map(toTurnSummary);
    return { v: PROTOCOL_VERSION, type: "conversation_resumed", conversation: this.toSummary(conv), turns };
  }

  setConfig(conversationId: string, config: ConversationConfig): ServerMessage {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return this.unknownConversation();
    const patch: { harness_id?: string; model?: string; effort?: string } = {};
    if (config.harnessId !== undefined) patch.harness_id = config.harnessId;
    if (config.model !== undefined) patch.model = config.model;
    if (config.effort !== undefined) patch.effort = config.effort;
    this.store.setConversationConfig(conversationId, patch);
    const row = this.store.getConversation(conversationId);
    return { v: PROTOCOL_VERSION, type: "config_updated", conversation: this.toSummary(row!) };
  }

  deleteConversation(conversationId: string): ServerMessage {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return this.unknownConversation();
    this.store.deleteConversation(conversationId);
    if (this.activeConversationId === conversationId) this.activeConversationId = null;
    return { v: PROTOCOL_VERSION, type: "deleted", conversationId };
  }

  async runTurn(
    conversationId: string,
    prompt: string,
    source: SourceLocation | null,
    domContext: DomContext,
    elements: PromptElement[],
    emit: Emit,
  ): Promise<void> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) {
      emit(this.unknownConversation());
      return;
    }
    if (this.activeTurn) {
      emit({
        v: PROTOCOL_VERSION,
        type: "blocked",
        reason: "busy",
        message: "A turn is already running in this conversation.",
      });
      return;
    }
    const harness = this.harnessFor(conv.harness_id);
    if (!harness || !harness.detected) {
      emit({ v: PROTOCOL_VERSION, type: "blocked", reason: "no_agent", message: NO_AGENT_HINT });
      return;
    }

    // Snapshot the tree before emitting turn_started so the only await stays
    // ahead of activeTurn being set (else a fast cancel would race and miss).
    const beforeDiff = await this.snapshotDiff();

    const seq = this.store.getTurns(conversationId).length + 1;
    const last = this.store.lastActiveTurn(conversationId);
    const resumeSessionId = last?.agent_session_id ?? null;

    const turnId = this.store.addTurn({
      conversation_id: conversationId,
      seq,
      prompt,
      source: source ? JSON.stringify(source) : null,
      dom_context: JSON.stringify(domContext),
      agent_session_id: null,
      checkpoint: null,
      parent_checkpoint: null,
      output: null,
      blocks: null,
      status: "running",
      created_at: Date.now(),
    });
    emit({ v: PROTOCOL_VERSION, type: "turn_started", conversationId, turnId, seq });

    const task: AgentTask = {
      prompt,
      source,
      domContext,
      elements,
      projectRoot: this.projectRoot,
      conversationId,
      resumeSessionId,
      model: conv.model || null,
      effort: conv.effort || null,
    };
    const inv = harness.adapter.invocation(task, harness.command);
    this.log(
      `task sent: harness=${harness.adapter.id} model=${conv.model || "default"} effort=${conv.effort} conversation=${conversationId} turn=${seq}`,
    );

    let outputText = "";
    let sessionId: string | null = null;
    let resultSuccess = false;
    let sawResult = false;
    const blocks: MessageBlock[] = [];

    try {
      const proc = Bun.spawn(inv.argv, {
        cwd: this.projectRoot,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: inv.stdin ? "pipe" : "ignore",
      });
      if (inv.stdin && proc.stdin) {
        proc.stdin.write(inv.stdin);
        proc.stdin.end();
      }
      this.activeTurn = { conversationId, turnId, proc, cancelled: false };

      const decoder = new TextDecoder();
      const stderrChunks: string[] = [];
      const stderrDrain = (async () => {
        const reader = proc.stderr.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stderrChunks.push(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
        }
      })();

      let buffer = "";
      const consume = (line: string): void => {
        const event = harness.adapter.parseLine(line);
        if (!event) return;
        emit({ v: PROTOCOL_VERSION, type: "agent_output", conversationId, turnId, event });
        if (event.kind === "text") {
          outputText += event.text;
          const tail = blocks[blocks.length - 1];
          if (tail && tail.t === "md") tail.text += event.text;
          else blocks.push({ t: "md", text: event.text });
        }
        if (event.kind === "tool") blocks.push({ t: "tool", name: event.name, detail: event.detail });
        if (event.kind === "status" && event.sessionId) sessionId = event.sessionId;
        if (event.kind === "result") {
          sawResult = true;
          resultSuccess = event.success;
          if (event.sessionId) sessionId = event.sessionId;
        }
      };

      const reader = proc.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            consume(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (buffer.length > 0) consume(buffer);

      await stderrDrain;
      const exitCode = await proc.exited;
      const stderrText = stderrChunks.join("");

      if (this.activeTurn?.cancelled) {
        this.store.setTurnStatus(turnId, "cancelled");
        this.activeTurn = null;
        emit({
          v: PROTOCOL_VERSION,
          type: "turn_complete",
          conversationId,
          turnId,
          checkpoint: null,
          success: false,
          summary: "cancelled",
        });
        return;
      }

      if (exitCode !== 0 && !sawResult) {
        this.store.setTurnStatus(turnId, "error");
        this.activeTurn = null;
        emit({
          v: PROTOCOL_VERSION,
          type: "turn_error",
          conversationId,
          turnId,
          message: stderrText.trim().slice(-500) || `agent exited with code ${exitCode}`,
        });
        return;
      }

      // Stream real diffs of what the harness changed in the working tree.
      for (const d of await this.collectDiffs(beforeDiff)) {
        emit({ v: PROTOCOL_VERSION, type: "agent_output", conversationId, turnId, event: d });
        blocks.push({ t: "diff", file: d.file, hunks: d.hunks });
      }

      this.log(`turn complete conversation=${conversationId} turn=${seq}`);
      this.store.updateTurn(turnId, {
        agent_session_id: sessionId,
        checkpoint: null,
        parent_checkpoint: null,
        output: outputText,
        blocks: JSON.stringify(blocks),
        status: "complete",
      });
      this.store.touchConversation(conversationId);
      this.activeTurn = null;

      const success = sawResult ? resultSuccess : true;
      const summary = outputText.trim().slice(0, 200) || "done";
      emit({
        v: PROTOCOL_VERSION,
        type: "turn_complete",
        conversationId,
        turnId,
        checkpoint: null,
        success,
        summary,
      });
    } catch (err) {
      this.store.setTurnStatus(turnId, "error");
      this.activeTurn = null;
      emit({
        v: PROTOCOL_VERSION,
        type: "turn_error",
        conversationId,
        turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async snapshotDiff(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      for (const b of parseUnifiedDiff(await this.git.rawDiff())) map.set(b.file, JSON.stringify(b.hunks));
    } catch {
      /* no git diff available */
    }
    return map;
  }

  private async collectDiffs(before: Map<string, string>): Promise<AgentEventLite[]> {
    let raw: string;
    try {
      raw = await this.git.rawDiff();
    } catch {
      return [];
    }
    return parseUnifiedDiff(raw)
      .filter((b) => before.get(b.file) !== JSON.stringify(b.hunks))
      .slice(0, MAX_DIFF_FILES);
  }

  cancel(conversationId: string): void {
    if (this.activeTurn && this.activeTurn.conversationId === conversationId) {
      this.activeTurn.cancelled = true;
      this.activeTurn.proc.kill();
    }
  }

  async revert(conversationId: string): Promise<ServerMessage> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return this.unknownConversation();
    return {
      v: PROTOCOL_VERSION,
      type: "error",
      message: "Revert is unavailable in direct-edit mode; undo the file change with your editor or git.",
    };
  }

  async accept(conversationId: string): Promise<ServerMessage> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return this.unknownConversation();
    this.store.setConversationStatus(conversationId, "accepted");
    if (this.activeConversationId === conversationId) this.activeConversationId = null;
    return { v: PROTOCOL_VERSION, type: "accepted", conversationId, mergeCommit: "" };
  }

  async discard(conversationId: string): Promise<ServerMessage> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return this.unknownConversation();
    this.store.setConversationStatus(conversationId, "discarded");
    if (this.activeConversationId === conversationId) this.activeConversationId = null;
    return { v: PROTOCOL_VERSION, type: "discarded", conversationId };
  }

  private toSummary(row: ConversationRow): ConversationSummary {
    const turns = this.store.getTurns(row.id);
    return {
      id: row.id,
      branch: row.branch,
      status: row.status,
      agentId: row.agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      turnCount: turns.length,
      title: turns[0]?.prompt ?? null,
      harnessId: row.harness_id,
      model: row.model,
      effort: row.effort,
    };
  }

  private unknownConversation(): ServerMessage {
    return {
      v: PROTOCOL_VERSION,
      type: "error",
      code: "unknown_conversation",
      message: "Unknown conversation.",
    };
  }
}

type AgentEventLite = { kind: "diff"; file: string; hunks: DiffHunk[] };

/** Parse `git diff --no-color` into per-file hunk blocks for streaming. */
function parseUnifiedDiff(raw: string): { kind: "diff"; file: string; hunks: DiffHunk[] }[] {
  if (!raw.trim()) return [];
  const files: { kind: "diff"; file: string; hunks: DiffHunk[] }[] = [];
  let cur: { kind: "diff"; file: string; hunks: DiffHunk[] } | null = null;
  let inHunk = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      cur = { kind: "diff", file: "", hunks: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+++ b/")) {
      cur.file = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ ")) {
      cur.file = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (cur.hunks.length >= MAX_DIFF_LINES) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) cur.hunks.push({ type: "add", text: line.slice(1) });
    else if (line.startsWith("-") && !line.startsWith("---")) cur.hunks.push({ type: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) cur.hunks.push({ type: "ctx", text: line.slice(1) });
  }
  return files.filter((f) => f.file && f.hunks.length > 0);
}

function toTurnSummary(row: TurnRow): TurnSummary {
  let blocks: MessageBlock[] = [];
  if (row.blocks) {
    try {
      const parsed: unknown = JSON.parse(row.blocks);
      if (Array.isArray(parsed)) blocks = parsed as MessageBlock[];
    } catch {
      /* corrupt/legacy blocks; fall back to text */
    }
  }
  if (blocks.length === 0 && row.output) blocks = [{ t: "md", text: row.output }];
  return {
    id: row.id,
    seq: row.seq,
    prompt: row.prompt,
    checkpoint: row.checkpoint,
    status: row.status,
    createdAt: row.created_at,
    output: row.output ?? "",
    blocks,
  };
}
