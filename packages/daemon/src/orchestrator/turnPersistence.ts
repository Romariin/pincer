import type { LiveTurnSnapshot, MessageBlock, TurnStatus } from "@pincer/core";
import type { Store } from "../store";
import type { TurnSubmission } from "../turnScheduler";
import { outputFromBlocks } from "./summaries";

type FinishedStatus = Extract<TurnStatus, "error" | "cancelled">;

export function persistCancelledQueuedTurn(
	store: Store,
	submission: TurnSubmission,
): number {
	const { id: turnId } = store.appendTurn({
		conversation_id: submission.conversationId,
		prompt: submission.prompt,
		source: submission.source ? JSON.stringify(submission.source) : null,
		dom_context: JSON.stringify(submission.domContext),
		harness_id: submission.selection.harnessId,
		resume_token: null,
		checkpoint: null,
		parent_checkpoint: null,
		output: null,
		blocks: JSON.stringify([]),
		status: "cancelled",
		created_at: Date.now(),
	});
	store.touchConversation(submission.conversationId);
	return turnId;
}

export function persistUnexpectedTurnError(
	store: Store,
	submission: TurnSubmission,
	snapshot: LiveTurnSnapshot,
	message: string,
): { turnId: number; seq: number } {
	const blocks = snapshot.blocks.length
		? snapshot.blocks
		: [{ t: "md" as const, text: message }];
	if (snapshot.turnId !== null && snapshot.seq !== null) {
		store.updateTurn(snapshot.turnId, {
			output: outputFromBlocks(blocks),
			blocks: JSON.stringify(blocks),
			status: "error",
		});
		return { turnId: snapshot.turnId, seq: snapshot.seq };
	}
	const persisted = store.appendTurn({
		conversation_id: submission.conversationId,
		prompt: submission.prompt,
		source: submission.source ? JSON.stringify(submission.source) : null,
		dom_context: JSON.stringify(submission.domContext),
		harness_id: submission.selection.harnessId,
		resume_token: null,
		checkpoint: null,
		parent_checkpoint: null,
		output: outputFromBlocks(blocks),
		blocks: JSON.stringify(blocks),
		status: "error",
		created_at: Date.now(),
	});
	return { turnId: persisted.id, seq: persisted.seq };
}

export function startTurnRow(
	store: Store,
	submission: TurnSubmission,
): { id: number; seq: number } {
	return store.appendTurn({
		conversation_id: submission.conversationId,
		prompt: submission.prompt,
		source: submission.source ? JSON.stringify(submission.source) : null,
		dom_context: JSON.stringify(submission.domContext),
		harness_id: submission.selection.harnessId,
		resume_token: null,
		checkpoint: null,
		parent_checkpoint: null,
		output: null,
		blocks: null,
		status: "running",
		created_at: Date.now(),
	});
}

export function abortTurnRow(
	store: Store,
	turnId: number,
	blocks: MessageBlock[],
	status: FinishedStatus,
): void {
	store.updateTurn(turnId, {
		output: outputFromBlocks(blocks),
		blocks: JSON.stringify(blocks),
		status,
	});
}
