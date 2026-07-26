import type {
	ConversationSummary,
	MessageBlock,
	TurnState,
	TurnSummary,
} from "@pincer/core";
import type { ConversationRow, TurnRow } from "../store";

export interface LiveTurnState {
	state: TurnState;
	queuePosition: number | null;
}

export function outputFromBlocks(blocks: MessageBlock[]): string {
	return blocks
		.filter(
			(block): block is Extract<MessageBlock, { t: "md" }> => block.t === "md",
		)
		.map((block) => block.text)
		.join("");
}

export function conversationSummary(
	row: ConversationRow,
	turns: TurnRow[],
	live: LiveTurnState,
): ConversationSummary {
	return {
		id: row.id,
		branch: row.branch,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		turnCount: turns.length,
		title: turns[0]?.prompt ?? null,
		harnessId: row.harness_id,
		model: row.model,
		effort: row.effort,
		turnState: live.state,
		queuePosition: live.queuePosition,
	};
}

export function turnSummary(row: TurnRow): TurnSummary {
	let blocks: MessageBlock[] = [];
	if (row.blocks) {
		try {
			const parsed: unknown = JSON.parse(row.blocks);
			if (Array.isArray(parsed)) blocks = parsed as MessageBlock[];
		} catch {
			/* Corrupt legacy blocks fall back to accumulated text. */
		}
	}
	if (blocks.length === 0 && row.output)
		blocks = [{ t: "md", text: row.output }];
	return {
		id: row.id,
		seq: row.seq,
		prompt: row.prompt,
		checkpoint: row.checkpoint,
		status: row.status,
		createdAt: row.created_at,
		output: row.output ?? "",
		blocks,
	};
}
