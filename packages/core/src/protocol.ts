import type { SourceLocation } from "./source";
import type { DomContext } from "./dom";

/** Normalized agent event streamed to the client (`AgentAdapter.parseLine` output). */
export type AgentEvent =
  | { kind: "status"; text: string; sessionId?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "result"; success: boolean; sessionId: string | null; summary?: string };

export interface ConversationSummary {
  id: string;
  branch: string;
  status: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

export interface TurnSummary {
  id: number;
  seq: number;
  prompt: string;
  checkpoint: string | null;
  status: string;
  createdAt: number;
}

/** Client -> Daemon messages. */
export type ClientMessage =
  | { v: number; type: "list_conversations" }
  | { v: number; type: "new_conversation"; force?: boolean }
  | { v: number; type: "resume_conversation"; conversationId: string }
  | {
      v: number;
      type: "prompt";
      conversationId: string;
      prompt: string;
      source: SourceLocation | null;
      domContext: DomContext;
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
      agent: { id: string; detected: boolean } | null;
    }
  | { v: number; type: "conversations"; items: ConversationSummary[] }
  | { v: number; type: "conversation_started"; conversation: ConversationSummary }
  | {
      v: number;
      type: "conversation_resumed";
      conversation: ConversationSummary;
      turns: TurnSummary[];
    }
  | {
      v: number;
      type: "blocked";
      reason: "dirty_working_tree" | "no_agent" | "busy";
      files?: string[];
      message: string;
    }
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
      code?: "merge_conflict" | "unknown_conversation" | "bad_message";
      message: string;
    };

export type ServerMessageType = ServerMessage["type"];
