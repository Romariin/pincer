import type { AgentAdapter } from "@pincer/core";
import { claudeAdapter } from "./claude";
import { ompAdapter } from "./omp";
import { codexAdapter } from "./codex";

/** All harnesses the daemon knows, in default-selection priority order. */
export const ADAPTERS: AgentAdapter[] = [claudeAdapter, ompAdapter, codexAdapter];

export function harnessById(id: string): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export interface AgentConfig {
  /** Force a single harness by id; error if unknown. */
  agentId?: string;
  /** Overridable base argv for the forced harness (default: its `defaultCommand`). */
  command?: string[];
}

export interface ResolvedHarness {
  adapter: AgentAdapter;
  command: string[];
  detected: boolean;
}

/**
 * Detect every available harness. With `agentId` set the daemon is restricted
 * to that one harness (and `command` overrides its argv); otherwise all
 * harnesses are probed and offered.
 */
export async function resolveHarnesses(config: AgentConfig): Promise<ResolvedHarness[]> {
  if (config.agentId && !harnessById(config.agentId)) {
    throw new Error(`Unknown agent id: ${config.agentId}`);
  }
  const list = config.agentId ? ADAPTERS.filter((a) => a.id === config.agentId) : ADAPTERS;
  return Promise.all(
    list.map(async (adapter) => {
      const command =
        config.agentId === adapter.id && config.command ? config.command : adapter.defaultCommand;
      const detected = await adapter.detect(command);
      return { adapter, command, detected };
    }),
  );
}
