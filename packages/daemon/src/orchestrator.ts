import {
  PROTOCOL_VERSION,
  type AgentTask,
  type ConversationSummary,
  type DomContext,
  type ServerMessage,
  type SourceLocation,
  type TurnSummary,
} from "@pincer/core";
import type { Git } from "./git";
import type { ResolvedAgent } from "./agents/registry";
import type { ConversationRow, Store, TurnRow } from "./store";

export type Emit = (msg: ServerMessage) => void;

export interface OrchestratorDeps {
  git: Git;
  store: Store;
  projectRoot: string;
  agent: ResolvedAgent | null;
  log?: (msg: string) => void;
}

interface ActiveTurn {
  conversationId: string;
  turnId: number;
  proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">;
  cancelled: boolean;
}

const NO_AGENT_HINT =
  "No supported coding agent detected. Install Claude Code (https://claude.com/claude-code) or configure one via pincer.config.json.";

/** Composes git + store + agent into the branch-per-conversation, checkpoint-per-turn lifecycle. */
export class Orchestrator {
  private readonly git: Git;
  private readonly store: Store;
  private readonly projectRoot: string;
  private readonly agent: ResolvedAgent | null;
  private readonly log: (msg: string) => void;

  private activeConversationId: string | null = null;
  private activeTurn: ActiveTurn | null = null;

  constructor(deps: OrchestratorDeps) {
    this.git = deps.git;
    this.store = deps.store;
    this.projectRoot = deps.projectRoot;
    this.agent = deps.agent;
    this.log = deps.log ?? (() => {});
  }

  get agentId(): string | null {
    return this.agent?.adapter.id ?? null;
  }

  listConversations(): ServerMessage {
    return { v: PROTOCOL_VERSION, type: "conversations", items: this.store.listConversations() };
  }

  async newConversation(force: boolean): Promise<ServerMessage> {
    if (!force && (await this.git.isDirty())) {
      return {
        v: PROTOCOL_VERSION,
        type: "blocked",
        reason: "dirty_working_tree",
        files: await this.git.dirtyFiles(),
        message:
          "Working tree has uncommitted changes. Commit or stash them, or resend with force to checkpoint them on the conversation branch.",
      };
    }

    const id = crypto.randomUUID().slice(0, 8);
    const branch = `pincer/${id}`;
    const baseBranch = await this.git.currentBranch();
    const baseCommit = await this.git.headSha();

    await this.git.createBranch(branch);
    if (force && (await this.git.isDirty())) {
      await this.git.commitAll("pincer: baseline (uncommitted work)");
    }

    const now = Date.now();
    this.store.createConversation({
      id,
      branch,
      base_branch: baseBranch,
      base_commit: baseCommit,
      status: "active",
      agent_id: this.agentId ?? "none",
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

    await this.git.checkout(conv.branch);
    this.activeConversationId = id;

    const turns = this.store.getTurns(id).map(toTurnSummary);
    return { v: PROTOCOL_VERSION, type: "conversation_resumed", conversation: this.toSummary(conv), turns };
  }

  async runTurn(
    conversationId: string,
    prompt: string,
    source: SourceLocation | null,
    domContext: DomContext,
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
    if (!this.agent) {
      emit({ v: PROTOCOL_VERSION, type: "blocked", reason: "no_agent", message: NO_AGENT_HINT });
      return;
    }

    if ((await this.git.currentBranch()) !== conv.branch) {
      await this.git.checkout(conv.branch);
    }

    const seq = this.store.getTurns(conversationId).length + 1;
    const last = this.store.lastActiveTurn(conversationId);
    // For turn 1 no commits exist on the branch yet, so HEAD is the branch tip at
    // creation (= base_commit when clean, or the forced baseline commit when dirty+force).
    const parent = last?.checkpoint ?? (await this.git.headSha());
    const resumeSessionId = last?.agent_session_id ?? null;

    const turnId = this.store.addTurn({
      conversation_id: conversationId,
      seq,
      prompt,
      source: source ? JSON.stringify(source) : null,
      dom_context: JSON.stringify(domContext),
      agent_session_id: null,
      checkpoint: null,
      parent_checkpoint: parent,
      output: null,
      status: "running",
      created_at: Date.now(),
    });
    emit({ v: PROTOCOL_VERSION, type: "turn_started", conversationId, turnId, seq });

    const task: AgentTask = {
      prompt,
      source,
      domContext,
      projectRoot: this.projectRoot,
      conversationId,
      resumeSessionId,
    };
    const inv = this.agent.adapter.invocation(task, this.agent.command);
    this.log(`task sent: agent=${this.agent.adapter.id} conversation=${conversationId} turn=${seq}`);

    let outputText = "";
    let sessionId: string | null = null;
    let resultSuccess = false;
    let sawResult = false;

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
        const event = this.agent!.adapter.parseLine(line);
        if (!event) return;
        emit({ v: PROTOCOL_VERSION, type: "agent_output", conversationId, turnId, event });
        if (event.kind === "text") outputText += event.text;
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

      const checkpoint = await this.git.commitAll(`pincer turn ${seq}: ${prompt.slice(0, 60)}`);
      this.log(
        `checkpoint created: ${checkpoint ?? "(no file changes)"} conversation=${conversationId} turn=${seq}`,
      );
      this.store.updateTurn(turnId, {
        agent_session_id: sessionId,
        checkpoint,
        parent_checkpoint: parent,
        output: outputText,
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
        checkpoint,
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

  cancel(conversationId: string): void {
    if (this.activeTurn && this.activeTurn.conversationId === conversationId) {
      this.activeTurn.cancelled = true;
      this.activeTurn.proc.kill();
    }
  }

  async revert(conversationId: string): Promise<ServerMessage> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return this.unknownConversation();

    const turn = this.store.lastActiveTurn(conversationId);
    if (!turn || !turn.parent_checkpoint) {
      return { v: PROTOCOL_VERSION, type: "error", message: "No turn to revert." };
    }

    await this.git.resetHard(turn.parent_checkpoint);
    this.store.setTurnStatus(turn.id, "reverted");
    this.store.touchConversation(conversationId);
    return { v: PROTOCOL_VERSION, type: "reverted", conversationId, checkpoint: turn.parent_checkpoint };
  }

  async accept(conversationId: string): Promise<ServerMessage> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return this.unknownConversation();

    await this.git.checkout(conv.base_branch);
    const res = await this.git.merge(conv.branch, `pincer: accept ${conv.id}`);
    if (!res.ok) {
      return {
        v: PROTOCOL_VERSION,
        type: "error",
        code: "merge_conflict",
        message: `Merge conflict accepting ${conv.branch}; branch left intact for manual resolution.`,
      };
    }
    await this.git.deleteBranch(conv.branch, false);
    this.store.setConversationStatus(conversationId, "accepted");
    if (this.activeConversationId === conversationId) this.activeConversationId = null;
    return { v: PROTOCOL_VERSION, type: "accepted", conversationId, mergeCommit: res.sha };
  }

  async discard(conversationId: string): Promise<ServerMessage> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return this.unknownConversation();

    await this.git.checkout(conv.base_branch);
    await this.git.deleteBranch(conv.branch, true);
    this.store.setConversationStatus(conversationId, "discarded");
    if (this.activeConversationId === conversationId) this.activeConversationId = null;
    return { v: PROTOCOL_VERSION, type: "discarded", conversationId };
  }

  private toSummary(row: ConversationRow): ConversationSummary {
    return {
      id: row.id,
      branch: row.branch,
      status: row.status,
      agentId: row.agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      turnCount: this.store.getTurns(row.id).length,
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

function toTurnSummary(row: TurnRow): TurnSummary {
  return {
    id: row.id,
    seq: row.seq,
    prompt: row.prompt,
    checkpoint: row.checkpoint,
    status: row.status,
    createdAt: row.created_at,
  };
}
