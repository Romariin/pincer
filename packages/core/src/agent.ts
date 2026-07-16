import type { SourceLocation } from "./source";
import type { DomContext } from "./dom";
import type { AgentEvent, HarnessInfo, PromptElement } from "./protocol";

export type { AgentEvent };

/** A fully-specified edit task handed to a CLI agent adapter (Contract B). */
export interface AgentTask {
  /** The user's plain-English request. */
  prompt: string;
  /** Resolved source location, or null when Contract A mapping failed (story 6). */
  source: SourceLocation | null;
  domContext: DomContext;
  /** All selected elements when multi-selecting; the daemon renders each in the prompt. */
  elements?: PromptElement[];
  projectRoot: string;
  conversationId: string;
  /** Prior CLI session to continue within this conversation (story 20). */
  resumeSessionId: string | null;
  /** Selected model id, or null / "" for the harness's own default. */
  model: string | null;
  /** Selected effort level (see EFFORTS), or null for the harness default. */
  effort: string | null;
}

export interface AgentInvocation {
  argv: string[];
  stdin?: string;
}

export interface AgentAdapter {
  /** Stable adapter id, e.g. "claude-code". */
  readonly id: string;
  /** Display metadata + model list for the command bar. */
  readonly info: HarnessInfo;
  /** Default base argv when the user does not override with --agent-command. */
  readonly defaultCommand: string[];
  /** Is this CLI installed? `command` is the overridable base argv. */
  detect(command: string[]): Promise<boolean>;
  /** Map a task to a subprocess invocation. `command` = overridable base argv. */
  invocation(task: AgentTask, command: string[]): AgentInvocation;
  /** Parse one stdout line into a normalized event, or null to ignore it. */
  parseLine(line: string): AgentEvent | null;
}

export interface AgentResult {
  success: boolean;
  sessionId: string | null;
  summary: string;
}
