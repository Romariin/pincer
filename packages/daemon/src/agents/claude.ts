import type { AgentAdapter, AgentEvent, HarnessInfo, HarnessModel } from "@pincer/core";
import { composePrompt } from "./prompt";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="hsl(14.8, 63.1%, 59.6%)"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"></path></svg>';

const info: HarnessInfo = {
  id: "claude-code",
  label: "Claude Code",
  glyph: ">_",
  c1: "#d98a63",
  c2: "#c26a3f",
  icon: CLAUDE_ICON,
  models: [
    { id: "", label: "Default" },
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
    { id: "haiku", label: "Haiku" },
  ],
  defaultModel: "",
  supportsEffort: false, // Claude Code has no reasoning-level flag
};

/** Auth for the Anthropic Models API: explicit API key, else the Claude Code OAuth session token. */
async function anthropicAuthHeaders(): Promise<Record<string, string> | null> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    headers["x-api-key"] = key;
    return headers;
  }
  try {
    const file = join(homedir(), ".claude", ".credentials.json");
    const creds = JSON.parse(await Bun.file(file).text()) as { claudeAiOauth?: { accessToken?: string } };
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) return null;
    headers.Authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
    return headers;
  } catch {
    return null;
  }
}

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

  /** List the account's available models from the Anthropic Models API; falls back to static on any failure. */
  async listModels(): Promise<HarnessModel[]> {
    try {
      const headers = await anthropicAuthHeaders();
      if (!headers) return [];
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
      const dynamic = (json.data ?? [])
        .map((m) => ({ id: m.id ?? "", label: m.display_name ?? m.id ?? "" }))
        .filter((m) => m.id.length > 0);
      if (dynamic.length === 0) return [];
      return [{ id: "", label: "Default" }, ...dynamic];
    } catch {
      return [];
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

    const type = msg.type;

    if (type === "system" && msg.subtype === "init") {
      const model = typeof msg.model === "string" ? ` (${msg.model as string})` : "";
      return { kind: "status", text: `agent ready${model}` };
    }

    if (type === "stream_event") {
      const event = msg.event as Record<string, unknown> | undefined;
      if (!event) return null;
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta && delta.type === "text_delta") {
          return { kind: "text", text: String(delta.text ?? "") };
        }
      }
      if (event.type === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block && block.type === "tool_use") {
          const input = block.input as Record<string, unknown> | undefined;
          const detail = input && typeof input.file_path === "string" ? (input.file_path as string) : undefined;
          return { kind: "tool", name: String(block.name ?? "tool"), detail };
        }
      }
      return null;
    }

    if (type === "result") {
      return {
        kind: "result",
        success: msg.is_error !== true,
        sessionId: typeof msg.session_id === "string" ? (msg.session_id as string) : null,
        summary: String(msg.result ?? "").slice(0, 500),
      };
    }

    return null;
  },
};
