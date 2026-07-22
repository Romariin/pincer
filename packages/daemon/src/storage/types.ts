import type { ConversationStatus, TurnStatus } from "@pincer/core";

export interface ConversationRow {
	id: string;
	branch: string;
	base_branch: string;
	base_commit: string;
	status: ConversationStatus;
	harness_id: string;
	model: string;
	effort: string;
	created_at: number;
	updated_at: number;
}

export interface TurnRow {
	id: number;
	conversation_id: string;
	seq: number;
	prompt: string;
	source: string | null;
	dom_context: string | null;
	harness_id: string;
	resume_token: string | null;
	checkpoint: string | null;
	parent_checkpoint: string | null;
	output: string | null;
	blocks: string | null;
	status: TurnStatus;
	created_at: number;
}

export type NewTurnRow = Omit<TurnRow, "id" | "seq">;
export type TurnPatch = Partial<
	Pick<
		TurnRow,
		| "harness_id"
		| "resume_token"
		| "checkpoint"
		| "parent_checkpoint"
		| "output"
		| "blocks"
		| "status"
	>
>;
