import { PROTOCOL_VERSION, type ServerMessage } from "@pincer/core";

const NO_HARNESS_HINT =
	"No coding Harness is available. Install or configure at least one supported CLI Harness.";

export function noHarnessBlocked(): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "blocked",
		reason: "harness_unavailable",
		message: NO_HARNESS_HINT,
	};
}

export function unknownHarnessBlocked(
	harnessId: string,
	conversationId?: string,
): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "blocked",
		reason: "unknown_harness",
		conversationId,
		message: `Unknown Harness: ${harnessId}.`,
	};
}

export function harnessUnavailableBlocked(
	harnessId: string,
	conversationId?: string,
): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "blocked",
		reason: "harness_unavailable",
		conversationId,
		message: `Harness is unavailable: ${harnessId}.`,
	};
}

export function outstandingTurnBlocked(
	conversationId: string,
	message: string,
): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "blocked",
		reason: "outstanding_turn",
		conversationId,
		message,
	};
}

export function shuttingDownBlocked(conversationId: string): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "blocked",
		reason: "busy",
		conversationId,
		message: "Pincer is shutting down.",
	};
}

export function unknownConversationError(
	conversationId?: string,
): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "error",
		conversationId,
		code: "unknown_conversation",
		message: "Unknown conversation.",
	};
}

export function revertUnavailableError(): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "error",
		message:
			"Revert is unavailable in direct-edit mode; undo the file change with your editor or git.",
	};
}

export function turnCancelled(
	conversationId: string,
	turnId: number,
): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "turn_cancelled",
		conversationId,
		turnId,
	};
}

export function turnFailed(
	conversationId: string,
	turnId: number,
	message: string,
): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "turn_error",
		conversationId,
		turnId,
		message,
	};
}

export function turnCompleted(
	conversationId: string,
	turnId: number,
	summary: string,
): ServerMessage {
	return {
		v: PROTOCOL_VERSION,
		type: "turn_complete",
		conversationId,
		turnId,
		checkpoint: null,
		success: true,
		summary,
	};
}
