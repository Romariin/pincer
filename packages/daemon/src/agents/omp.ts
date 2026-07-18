import { join } from "node:path";
import type { AgentAdapter, AgentEvent, HarnessInfo, HarnessModel } from "@pincer/core";
import { composePrompt } from "./prompt";

const info: HarnessInfo = {
  id: "omp",
  label: "OMP",
  glyph: "◇",
  c1: "#a08be2",
  c2: "#7a5fd0",
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ed4abf"/><stop offset=".5" stop-color="#9b4dff"/><stop offset="1" stop-color="#5ad8e6"/></linearGradient></defs><path fill="url(#g)" d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z"/></svg>',
  models: [
    { id: "", label: "Default" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "gpt-5", label: "GPT-5" },
  ],
  defaultModel: "",
  supportsEffort: true,
};

// EFFORTS → omp `--thinking` levels.
const THINKING: Record<string, string> = {
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  Max: "max",
};

/** Contract B adapter for the omp (Oh My Pi) CLI. */
export const ompAdapter: AgentAdapter = {
  id: "omp",
  info,
  defaultCommand: ["omp"],

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

  async listModels(command: string[]): Promise<HarnessModel[]> {
    try {
      const proc = Bun.spawn([...command, "models", "--json"], {
        env: process.env,
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        signal: AbortSignal.timeout(10_000),
      });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) return [];
      const parsed = JSON.parse(out) as {
        models?: Array<{ selector?: string; id?: string; name?: string; thinking?: string[] | null }>;
      };
      const dynamic = (parsed.models ?? [])
        .map((m) => {
          const model: HarnessModel = {
            id: m.selector ?? m.id ?? "",
            label: m.name ?? m.id ?? m.selector ?? "",
          };
          if (Array.isArray(m.thinking) && m.thinking.length > 0) model.efforts = m.thinking;
          return model;
        })
        .filter((m) => m.id.length > 0);
      if (dynamic.length === 0) return [];
      return [{ id: "", label: "Default" }, ...dynamic];
    } catch {
      return [];
    }
  },

  invocation(task, command) {
    const sessionDir = join(task.projectRoot, ".pincer/omp-sessions");
    // Effort is either a shared capitalized label (map via THINKING) or a raw
    // per-model omp level (pass through unchanged).
    const thinking = task.effort ? (THINKING[task.effort] ?? task.effort) : undefined;
    const argv = [
      ...command,
      "-p",
      "--mode",
      "json",
      "--auto-approve",
      "--session-dir",
      sessionDir,
      ...(task.model ? ["--model", task.model] : []),
      ...(thinking ? ["--thinking", thinking] : []),
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

    const type = msg.type;

    if (type === "session") {
      const id = typeof msg.id === "string" ? (msg.id as string) : undefined;
      return { kind: "status", text: `omp session${id ? ` ${id.slice(0, 8)}` : ""}`, sessionId: id };
    }

    if (type === "message_update") {
      const event = msg.assistantMessageEvent as Record<string, unknown> | undefined;
      if (event && event.type === "text_delta") {
        return { kind: "text", text: String(event.delta ?? "") };
      }
      return null;
    }

    if (type === "tool_execution_start") {
      const args = msg.args as Record<string, unknown> | undefined;
      const detail =
        args && typeof args.path === "string"
          ? (args.path as string)
          : args && typeof args.file === "string"
            ? (args.file as string)
            : undefined;
      return { kind: "tool", name: String(msg.toolName ?? msg.name ?? "tool"), detail };
    }

    if (type === "agent_end") {
      return { kind: "result", success: true, sessionId: null, summary: "" };
    }

    return null;
  },
};
