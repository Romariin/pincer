import type { AgentAdapter, AgentEvent, HarnessInfo } from "@pincer/core";
import { composePrompt } from "./prompt";

const info: HarnessInfo = {
  id: "claude-code",
  label: "Claude Code",
  glyph: ">_",
  c1: "#d98a63",
  c2: "#c26a3f",
  models: [
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
    { id: "haiku", label: "Haiku" },
  ],
  defaultModel: "sonnet",
  supportsEffort: false, // Claude Code has no reasoning-level flag
};

/** Contract B adapter for Anthropic's Claude Code CLI. */
export const claudeAdapter: AgentAdapter = {
  id: "claude-code",
  info,
  defaultCommand: ["claude"],

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
    const argv = [
      ...command,
      "-p",
      composePrompt(task),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
      ...(task.model ? ["--model", task.model] : []),
      ...(task.resumeSessionId ? ["--resume", task.resumeSessionId] : []),
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

    const type = msg["type"];

    if (type === "system" && msg["subtype"] === "init") {
      const model = typeof msg["model"] === "string" ? ` (${msg["model"] as string})` : "";
      return { kind: "status", text: "agent ready" + model };
    }

    if (type === "stream_event") {
      const event = msg["event"] as Record<string, unknown> | undefined;
      if (!event) return null;
      if (event["type"] === "content_block_delta") {
        const delta = event["delta"] as Record<string, unknown> | undefined;
        if (delta && delta["type"] === "text_delta") {
          return { kind: "text", text: String(delta["text"] ?? "") };
        }
      }
      if (event["type"] === "content_block_start") {
        const block = event["content_block"] as Record<string, unknown> | undefined;
        if (block && block["type"] === "tool_use") {
          const input = block["input"] as Record<string, unknown> | undefined;
          const detail = input && typeof input["file_path"] === "string" ? (input["file_path"] as string) : undefined;
          return { kind: "tool", name: String(block["name"] ?? "tool"), detail };
        }
      }
      return null;
    }

    if (type === "result") {
      return {
        kind: "result",
        success: msg["is_error"] !== true,
        sessionId: typeof msg["session_id"] === "string" ? (msg["session_id"] as string) : null,
        summary: String(msg["result"] ?? "").slice(0, 500),
      };
    }

    return null;
  },
};
