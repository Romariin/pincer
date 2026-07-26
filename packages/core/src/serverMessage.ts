import { PROTOCOL_VERSION } from "./constants";
import type { ServerMessage } from "./protocol";
import {
	isConversation,
	isHarnessDescriptor,
	isHarnessEvent,
	isLiveTurn,
	isOverlaySettings,
	isRequestType,
	isTurn,
} from "./protocolGuards";
import {
	asRecord,
	hasOnlyKeys,
	isNonNegativeInteger,
	isNullableIndex,
	isNullableString,
	isString,
	isStringArray,
} from "./valueGuards";

export type ServerMessageParseResult =
	| { ok: true; value: ServerMessage }
	| { ok: false; error: string };

const SERVER_MESSAGE_KEYS: Record<string, readonly string[]> = {
	welcome: [
		"v",
		"type",
		"daemonVersion",
		"protocolVersion",
		"projectRoot",
		"harnesses",
		"defaultHarnessId",
	],
	conversations: ["v", "type", "items"],
	conversation_started: ["v", "type", "conversation"],
	conversation_resumed: ["v", "type", "conversation", "turns", "liveTurn"],
	config_updated: ["v", "type", "conversation"],
	deleted: ["v", "type", "conversationId"],
	blocked: ["v", "type", "reason", "conversationId", "files", "message"],
	overlay_settings: ["v", "type", "settings"],
	turn_queued: ["v", "type", "conversationId", "liveTurn"],
	turn_started: ["v", "type", "conversationId", "turnId", "seq", "liveTurn"],
	harness_output: ["v", "type", "conversationId", "turnId", "event"],
	turn_complete: [
		"v",
		"type",
		"conversationId",
		"turnId",
		"checkpoint",
		"success",
		"summary",
	],
	turn_error: ["v", "type", "conversationId", "turnId", "message"],
	turn_cancelled: ["v", "type", "conversationId", "turnId"],
	reverted: ["v", "type", "conversationId", "checkpoint"],
	accepted: ["v", "type", "conversationId", "mergeCommit"],
	discarded: ["v", "type", "conversationId"],
	error: ["v", "type", "conversationId", "requestType", "code", "message"],
};

function fail(error: string): ServerMessageParseResult {
	return { ok: false, error };
}

export function parseServerMessage(raw: unknown): ServerMessageParseResult {
	const message = asRecord(raw);
	if (!message) return fail("Expected an object.");
	if (message.v !== PROTOCOL_VERSION)
		return fail("Unsupported protocol version.");
	if (!isString(message.type)) return fail("Invalid message type.");
	const allowed = SERVER_MESSAGE_KEYS[message.type];
	if (!allowed) return fail("Unknown message type.");
	if (!hasOnlyKeys(message, allowed))
		return fail(`Invalid ${message.type} message.`);

	let valid = false;
	switch (message.type) {
		case "welcome":
			valid =
				isString(message.daemonVersion) &&
				message.protocolVersion === PROTOCOL_VERSION &&
				isString(message.projectRoot) &&
				Array.isArray(message.harnesses) &&
				message.harnesses.every(isHarnessDescriptor) &&
				(message.defaultHarnessId === null ||
					isString(message.defaultHarnessId));
			break;
		case "conversations":
			valid =
				Array.isArray(message.items) && message.items.every(isConversation);
			break;
		case "conversation_started":
		case "config_updated":
			valid = isConversation(message.conversation);
			break;
		case "conversation_resumed": {
			const resumedConversation = asRecord(message.conversation);
			const resumedLiveTurn =
				message.liveTurn === null ? null : asRecord(message.liveTurn);
			valid =
				isConversation(resumedConversation) &&
				Array.isArray(message.turns) &&
				message.turns.every(isTurn) &&
				(message.liveTurn === null
					? resumedConversation?.turnState === "idle"
					: isLiveTurn(resumedLiveTurn) &&
						!!resumedLiveTurn &&
						!!resumedConversation &&
						resumedLiveTurn.conversationId === resumedConversation.id &&
						resumedLiveTurn?.state === resumedConversation?.turnState &&
						resumedLiveTurn?.queuePosition ===
							resumedConversation?.queuePosition);
			break;
		}
		case "deleted":
		case "discarded":
			valid = isString(message.conversationId);
			break;
		case "blocked":
			valid =
				(message.reason === "dirty_working_tree" ||
					message.reason === "busy" ||
					message.reason === "unknown_harness" ||
					message.reason === "harness_unavailable" ||
					message.reason === "outstanding_turn") &&
				(message.conversationId === undefined ||
					isString(message.conversationId)) &&
				(message.files === undefined || isStringArray(message.files)) &&
				isString(message.message);
			break;
		case "overlay_settings":
			valid = isOverlaySettings(message.settings);
			break;
		case "turn_queued": {
			const live = asRecord(message.liveTurn);
			valid =
				isString(message.conversationId) &&
				isLiveTurn(live) &&
				live?.conversationId === message.conversationId &&
				live.turnId === null &&
				live.seq === null &&
				live.state === "queued" &&
				isNonNegativeInteger(live.queuePosition);
			break;
		}
		case "turn_started": {
			const live = asRecord(message.liveTurn);
			valid =
				isString(message.conversationId) &&
				isNonNegativeInteger(message.turnId) &&
				isNonNegativeInteger(message.seq) &&
				isLiveTurn(live) &&
				live?.conversationId === message.conversationId &&
				live.turnId === message.turnId &&
				live.seq === message.seq &&
				live.state === "running" &&
				live.queuePosition === null;
			break;
		}
		case "harness_output":
			valid =
				isString(message.conversationId) &&
				isNonNegativeInteger(message.turnId) &&
				isHarnessEvent(message.event);
			break;
		case "turn_complete":
			valid =
				isString(message.conversationId) &&
				isNonNegativeInteger(message.turnId) &&
				isNullableString(message.checkpoint) &&
				typeof message.success === "boolean" &&
				isString(message.summary);
			break;
		case "turn_error":
			valid =
				isString(message.conversationId) &&
				isNullableIndex(message.turnId) &&
				isString(message.message);
			break;
		case "turn_cancelled":
			valid =
				isString(message.conversationId) && isNullableIndex(message.turnId);
			break;
		case "reverted":
			valid = isString(message.conversationId) && isString(message.checkpoint);
			break;
		case "accepted":
			valid = isString(message.conversationId) && isString(message.mergeCommit);
			break;
		case "error":
			valid =
				(message.conversationId === undefined ||
					isString(message.conversationId)) &&
				(message.requestType === undefined ||
					isRequestType(message.requestType)) &&
				(message.code === undefined ||
					message.code === "merge_conflict" ||
					message.code === "unknown_conversation" ||
					message.code === "bad_message" ||
					message.code === "internal_error" ||
					message.code === "settings_unavailable" ||
					message.code === "unknown_harness" ||
					message.code === "harness_unavailable") &&
				isString(message.message);
			break;
		default:
			return fail("Unknown message type.");
	}

	return valid
		? { ok: true, value: message as unknown as ServerMessage }
		: fail(`Invalid ${message.type} message.`);
}
