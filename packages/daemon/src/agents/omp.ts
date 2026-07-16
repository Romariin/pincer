import { join } from "node:path";
import type { AgentAdapter, AgentEvent } from "@pincer/core";
import { composePrompt } from "./prompt";

/** Contract B adapter for the omp (Oh My Pi) CLI. */
export const ompAdapter: AgentAdapter = {
  id: "omp",
  defaultCommand: ["omp"],

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
    const sessionDir = join(task.projectRoot, ".pincer/omp-sessions");
    const argv = [
      ...command,
      "-p",
      "--mode",
      "json",
      "--auto-approve",
      "--session-dir",
      sessionDir,
      ...(task.resumeSessionId ? ["-r", task.resumeSessionId] : []),
      composePrompt(task), // trailing positional MESSAGES arg
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

    if (type === "session") {
      const id = typeof msg["id"] === "string" ? (msg["id"] as string) : undefined;
      return { kind: "status", text: "omp session" + (id ? " " + id.slice(0, 8) : ""), sessionId: id };
    }

    if (type === "message_update") {
      const event = msg["assistantMessageEvent"] as Record<string, unknown> | undefined;
      if (event && event["type"] === "text_delta") {
        return { kind: "text", text: String(event["delta"] ?? "") };
      }
      return null;
    }

    if (type === "tool_execution_start") {
      return { kind: "tool", name: String(msg["toolName"] ?? msg["name"] ?? "tool") };
    }

    if (type === "agent_end") {
      return { kind: "result", success: true, sessionId: null, summary: "" };
    }

    return null;
  },
};
