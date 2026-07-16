import type { AgentAdapter } from "@pincer/core";
import { claudeAdapter } from "./claude";
import { ompAdapter } from "./omp";

/** Adapters ordered by auto-detect priority (Claude first). */
const ADAPTERS: AgentAdapter[] = [claudeAdapter, ompAdapter];

export interface AgentConfig {
  /** Force a specific adapter id; error if unknown. */
  agentId?: string;
  /** Overridable base argv for the agent CLI (default: the selected adapter's `defaultCommand`). */
  command?: string[];
}

export interface ResolvedAgent {
  adapter: AgentAdapter;
  command: string[];
}

/**
 * Resolve the agent to use. Returns null when the requested/auto-detected CLI
 * is not installed (story 13 → welcome{agent:null}).
 */
export async function resolveAgent(config: AgentConfig): Promise<ResolvedAgent | null> {
  if (config.agentId) {
    const adapter = ADAPTERS.find((a) => a.id === config.agentId);
    if (!adapter) throw new Error(`Unknown agent id: ${config.agentId}`);
    const command = config.command ?? adapter.defaultCommand;
    return (await adapter.detect(command)) ? { adapter, command } : null;
  }

  for (const adapter of ADAPTERS) {
    const command = config.command ?? adapter.defaultCommand;
    if (await adapter.detect(command)) return { adapter, command };
  }
  return null;
}
