import type { AgentAdapter, AgentEvent } from "@pincer/core";
import { composePrompt } from "./prompt";

/** Contract B adapter for Anthropic's Claude Code CLI. */
export const claudeAdapter: AgentAdapter = {
  id: "claude-code",
  defaultCommand: ["claude"],

  async detect(command: string[]): Promise<boolean> {
    try {
      const proc = Bun.spawn([...command, "--version"], {
        env: process.env,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
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
          return { kind: "tool", name: String(block["name"] ?? "tool") };
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
