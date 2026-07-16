import type { AgentAdapter, AgentEvent, HarnessInfo } from "@pincer/core";
import { composePrompt } from "./prompt";

const info: HarnessInfo = {
  id: "codex",
  label: "Codex",
  glyph: "{}",
  c1: "#3ecf8e",
  c2: "#199e68",
  models: [
    { id: "gpt-5.1-codex", label: "GPT-5 Codex" },
    { id: "gpt-5", label: "GPT-5" },
    { id: "o4-mini", label: "o4-mini" },
  ],
  defaultModel: "gpt-5.1-codex",
  supportsEffort: true,
};

// EFFORTS → codex `model_reasoning_effort`.
const REASONING: Record<string, string> = {
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  Max: "xhigh",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Contract B adapter for OpenAI's Codex CLI (`codex exec`).
 * The `--json` event schema is versioned; parseLine tolerates both the legacy
 * `{msg:{type}}` envelope and the newer `{type:"item.*",item}` shape.
 * (unverified against a live codex install — codex is detect-gated.)
 */
export const codexAdapter: AgentAdapter = {
  id: "codex",
  info,
  defaultCommand: ["codex"],

  async detect(command: string[]): Promise<boolean> {
    try {
      const proc = Bun.spawn([...command, "--version"], {
        env: process.env,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  },

  invocation(task, command) {
    const effort = task.effort ? REASONING[task.effort] : undefined;
    const argv = [
      ...command,
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      ...(task.model ? ["-m", task.model] : []),
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      composePrompt(task),
    ];
    return { argv };
  },

  parseLine(line: string): AgentEvent | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object") return null;
      msg = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    // Legacy envelope: { id, msg: { type, ... } }
    const inner = msg["msg"] as Record<string, unknown> | undefined;
    if (inner && typeof inner["type"] === "string") {
      const t = inner["type"] as string;
      if (t === "session_configured") {
        return { kind: "status", text: "codex session", sessionId: str(inner["session_id"]) };
      }
      if (t === "agent_message_delta") return { kind: "text", text: String(inner["delta"] ?? "") };
      if (t === "agent_message") return { kind: "text", text: String(inner["message"] ?? "") };
      if (t === "exec_command_begin" || t === "patch_apply_begin") {
        return { kind: "tool", name: t === "patch_apply_begin" ? "Edit" : "Bash", detail: str(inner["command"]) ?? str(inner["path"]) };
      }
      if (t === "task_complete" || t === "turn_complete") {
        return { kind: "result", success: true, sessionId: null, summary: String(inner["last_agent_message"] ?? "") };
      }
      return null;
    }

    // Newer envelope: { type: "item.completed", item: { item_type|type, text|... } }
    const type = str(msg["type"]);
    if (type && type.startsWith("item")) {
      const item = msg["item"] as Record<string, unknown> | undefined;
      const it = item ? str(item["item_type"]) ?? str(item["type"]) : undefined;
      if (item && (it === "assistant_message" || it === "agent_message")) {
        return { kind: "text", text: String(item["text"] ?? item["message"] ?? "") };
      }
      if (item && (it === "command_execution" || it === "file_change")) {
        return { kind: "tool", name: it === "file_change" ? "Edit" : "Bash", detail: str(item["command"]) ?? str(item["path"]) };
      }
      return null;
    }

    if (type === "turn.completed" || type === "thread.completed") {
      return { kind: "result", success: true, sessionId: str(msg["thread_id"]) ?? null, summary: "" };
    }

    return null;
  },
};
