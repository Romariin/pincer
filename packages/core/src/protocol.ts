import type { SourceLocation } from "./source";
import type { DomContext } from "./dom";

/** A selectable model within a harness (the "agent" segment of the command bar). */
export interface HarnessModel {
  id: string;
  label: string;
  /** Thinking levels this model supports (raw CLI values); omit to use the harness's shared efforts. */
  efforts?: string[];
}

/** A coding CLI the daemon can drive (the "harness" segment of the command bar). */
export interface HarnessInfo {
  id: string;
  label: string;
  /** Short monogram rendered in the harness avatar, e.g. ">_". */
  glyph: string;
  /** Optional raw SVG markup rendered in the avatar in place of the glyph. */
  icon?: string;
  /** Avatar gradient endpoints. */
  c1: string;
  c2: string;
  models: HarnessModel[];
  /** `id` of the default model (may be "" meaning the CLI's own default). */
  defaultModel: string;
  /** Whether the harness maps the effort segment onto a real reasoning flag. */
  supportsEffort: boolean;
}

export interface HarnessAvailability extends HarnessInfo {
  detected: boolean;
}

/** Effort levels for the command bar; map onto each harness's reasoning flag. */
export const EFFORTS = ["Minimal", "Low", "Medium", "High", "Max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = "High";

/** One line of a unified diff hunk streamed to the client. */
export interface DiffHunk {
  type: "add" | "del" | "ctx";
  text: string;
}

/** A persisted assistant content block, replayed when a conversation resumes. */
export type MessageBlock =
  | { t: "md"; text: string }
  | { t: "tool"; name: string; detail?: string }
  | { t: "diff"; file: string; hunks: DiffHunk[] };

/** Normalized agent event streamed to the client (`AgentAdapter.parseLine` output). */
export type AgentEvent =
  | { kind: "status"; text: string; sessionId?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "diff"; file: string; hunks: DiffHunk[] }
  | { kind: "result"; success: boolean; sessionId: string | null; summary?: string };

export interface ConversationSummary {
  id: string;
  branch: string;
  status: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  /** First turn's prompt, used as the list title; null before any turn runs. */
  title: string | null;
  /** Command-bar configuration for this conversation. */
  harnessId: string;
  model: string;
  effort: string;
}

export interface TurnSummary {
  id: number;
  seq: number;
  prompt: string;
  checkpoint: string | null;
  status: string;
  createdAt: number;
  /** Accumulated assistant text, so a resumed conversation can replay it. */
  output: string;
  /** Structured assistant blocks (md/tool/diff) for faithful replay on resume. */
  blocks: MessageBlock[];
}

/** One selected element attached to a prompt (multi-select). */
export interface PromptElement {
  source: SourceLocation | null;
  domContext: DomContext;
}

/** Command-bar selection carried on conversation create / config change. */
export interface ConversationConfig {
  harnessId?: string;
  model?: string;
  effort?: string;
}

export interface KeyboardShortcut {
  code: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

export const DEFAULT_TOGGLE_SHORTCUT: KeyboardShortcut = {
  code: "KeyP",
  alt: true,
  ctrl: false,
  shift: true,
  meta: false,
};

const FORBIDDEN_SHORTCUT_CODES: Record<string, true> = {
  Escape: true,
  Unidentified: true,
  AltLeft: true,
  AltRight: true,
  ControlLeft: true,
  ControlRight: true,
  ShiftLeft: true,
  ShiftRight: true,
  MetaLeft: true,
  MetaRight: true,
};

export function isKeyboardShortcut(value: unknown): value is KeyboardShortcut {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.code) ||
    Object.hasOwn(FORBIDDEN_SHORTCUT_CODES, value.code)
  ) {
    return false;
  }
  if (
    !("alt" in value) ||
    typeof value.alt !== "boolean" ||
    !("ctrl" in value) ||
    typeof value.ctrl !== "boolean" ||
    !("shift" in value) ||
    typeof value.shift !== "boolean" ||
    !("meta" in value) ||
    typeof value.meta !== "boolean"
  ) {
    return false;
  }
  return value.alt || value.ctrl || value.meta;
}

export interface OverlaySettings {
  appRoot: string;
  appOrigin: string;
  shortcut: KeyboardShortcut;
  showFloatingButton: boolean;
}

/** Client -> Daemon messages. */
export type ClientMessage =
  | { v: number; type: "list_conversations" }
  | ({ v: number; type: "new_conversation"; force?: boolean } & ConversationConfig)
  | { v: number; type: "resume_conversation"; conversationId: string }
  | ({ v: number; type: "set_config"; conversationId: string } & ConversationConfig)
  | { v: number; type: "delete_conversation"; conversationId: string }
  | {
      v: number;
      type: "prompt";
      conversationId: string;
      prompt: string;
      /** Primary selected element (first of `elements`); kept for storage + single-select. */
      source: SourceLocation | null;
      domContext: DomContext;
      /** All selected elements when multi-selecting; omitted/empty falls back to the primary. */
      elements?: PromptElement[];
    }
  | { v: number; type: "get_overlay_settings"; appRoot: string; appOrigin: string }
  | {
      v: number;
      type: "update_overlay_settings";
      appRoot: string;
      appOrigin: string;
      shortcut?: KeyboardShortcut;
      showFloatingButton?: boolean;
    }

  | { v: number; type: "cancel"; conversationId: string }
  | { v: number; type: "revert"; conversationId: string }
  | { v: number; type: "accept"; conversationId: string }
  | { v: number; type: "discard"; conversationId: string };

export type ClientMessageType = ClientMessage["type"];

/** Daemon -> Client messages. */
export type ServerMessage =
  | {
      v: number;
      type: "welcome";
      daemonVersion: string;
      protocolVersion: number;
      projectRoot: string;
      /** Every harness the daemon knows, with live install detection. */
      harnesses: HarnessAvailability[];
      efforts: string[];
      /** Harness selected by default for new conversations, or null when none detected. */
      defaultHarnessId: string | null;
    }
  | { v: number; type: "conversations"; items: ConversationSummary[] }
  | { v: number; type: "conversation_started"; conversation: ConversationSummary }
  | {
      v: number;
      type: "conversation_resumed";
      conversation: ConversationSummary;
      turns: TurnSummary[];
    }
  | { v: number; type: "config_updated"; conversation: ConversationSummary }
  | { v: number; type: "deleted"; conversationId: string }
  | {
      v: number;
      type: "blocked";
      reason: "dirty_working_tree" | "no_agent" | "busy";
      files?: string[];
      message: string;
    }
  | { v: number; type: "overlay_settings"; settings: OverlaySettings }

  | { v: number; type: "turn_started"; conversationId: string; turnId: number; seq: number }
  | { v: number; type: "agent_output"; conversationId: string; turnId: number; event: AgentEvent }
  | {
      v: number;
      type: "turn_complete";
      conversationId: string;
      turnId: number;
      checkpoint: string | null;
      success: boolean;
      summary: string;
    }
  | { v: number; type: "turn_error"; conversationId: string; turnId: number; message: string }
  | { v: number; type: "reverted"; conversationId: string; checkpoint: string }
  | { v: number; type: "accepted"; conversationId: string; mergeCommit: string }
  | { v: number; type: "discarded"; conversationId: string }
  | {
      v: number;
      type: "error";
      code?: "merge_conflict" | "unknown_conversation" | "bad_message" | "settings_unavailable";
      message: string;
    };

export type ServerMessageType = ServerMessage["type"];
