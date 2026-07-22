import { PROTOCOL_VERSION } from "./constants";
import { isKeyboardShortcut, type ServerMessage } from "./protocol";

export type ServerMessageParseResult =
	| { ok: true; value: ServerMessage }
	| { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function only(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function string(value: unknown): value is string {
	return typeof value === "string";
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function integer(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nullableString(value: unknown): boolean {
	return value === null || string(value);
}

function nullableInteger(value: unknown): boolean {
	return value === null || integer(value);
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(string);
}

function requestType(value: unknown): boolean {
	return (
		value === "list_conversations" ||
		value === "new_conversation" ||
		value === "resume_conversation" ||
		value === "set_config" ||
		value === "delete_conversation" ||
		value === "prompt" ||
		value === "get_overlay_settings" ||
		value === "update_overlay_settings" ||
		value === "cancel" ||
		value === "revert" ||
		value === "accept" ||
		value === "discard"
	);
}

function messageBlock(value: unknown): boolean {
	const block = record(value);
	if (!block || !string(block.t)) return false;
	switch (block.t) {
		case "md":
			return only(block, ["t", "text"]) && string(block.text);
		case "tool":
			return (
				only(block, ["t", "name", "detail"]) &&
				string(block.name) &&
				(block.detail === undefined || string(block.detail))
			);
		case "diff":
			return (
				only(block, ["t", "file", "hunks"]) &&
				string(block.file) &&
				Array.isArray(block.hunks) &&
				block.hunks.every((value) => {
					const hunk = record(value);
					return (
						!!hunk &&
						only(hunk, ["type", "text"]) &&
						(hunk.type === "add" ||
							hunk.type === "del" ||
							hunk.type === "ctx") &&
						string(hunk.text)
					);
				})
			);
		default:
			return false;
	}
}

function harnessEvent(value: unknown): boolean {
	const event = record(value);
	if (!event || !string(event.kind)) return false;
	switch (event.kind) {
		case "status":
		case "text":
			return only(event, ["kind", "text"]) && string(event.text);
		case "tool":
			return (
				only(event, ["kind", "name", "detail"]) &&
				string(event.name) &&
				(event.detail === undefined || string(event.detail))
			);
		case "diff":
			return (
				only(event, ["kind", "file", "hunks"]) &&
				messageBlock({ t: "diff", file: event.file, hunks: event.hunks })
			);
		case "session":
			return only(event, ["kind", "token"]) && string(event.token);
		case "result":
			return (
				only(event, ["kind", "success", "summary"]) &&
				typeof event.success === "boolean" &&
				(event.summary === undefined || string(event.summary))
			);
		default:
			return false;
	}
}

function conversation(value: unknown): boolean {
	const item = record(value);
	const stateValid =
		item?.turnState === "queued"
			? integer(item.queuePosition)
			: (item?.turnState === "idle" || item?.turnState === "running") &&
				item.queuePosition === null;
	return (
		!!item &&
		only(item, [
			"id",
			"branch",
			"status",
			"createdAt",
			"updatedAt",
			"turnCount",
			"title",
			"harnessId",
			"model",
			"effort",
			"turnState",
			"queuePosition",
		]) &&
		string(item.id) &&
		string(item.branch) &&
		(item.status === "active" ||
			item.status === "accepted" ||
			item.status === "discarded") &&
		finite(item.createdAt) &&
		finite(item.updatedAt) &&
		integer(item.turnCount) &&
		nullableString(item.title) &&
		string(item.harnessId) &&
		string(item.model) &&
		string(item.effort) &&
		stateValid
	);
}

function turn(value: unknown): boolean {
	const item = record(value);
	return (
		!!item &&
		only(item, [
			"id",
			"seq",
			"prompt",
			"checkpoint",
			"status",
			"createdAt",
			"output",
			"blocks",
		]) &&
		integer(item.id) &&
		integer(item.seq) &&
		string(item.prompt) &&
		nullableString(item.checkpoint) &&
		(item.status === "running" ||
			item.status === "complete" ||
			item.status === "error" ||
			item.status === "cancelled" ||
			item.status === "reverted") &&
		finite(item.createdAt) &&
		string(item.output) &&
		Array.isArray(item.blocks) &&
		item.blocks.every(messageBlock)
	);
}

function selection(value: unknown): boolean {
	const item = record(value);
	return (
		!!item &&
		only(item, ["harnessId", "model", "effort"]) &&
		string(item.harnessId) &&
		string(item.model) &&
		string(item.effort)
	);
}

function liveTurn(value: unknown): boolean {
	const item = record(value);
	const stateValid =
		item?.state === "queued"
			? item.turnId === null && item.seq === null && integer(item.queuePosition)
			: item?.state === "running" &&
				integer(item.turnId) &&
				integer(item.seq) &&
				item.queuePosition === null;
	return (
		!!item &&
		only(item, [
			"conversationId",
			"turnId",
			"seq",
			"state",
			"queuePosition",
			"prompt",
			"blocks",
			"selection",
		]) &&
		string(item.conversationId) &&
		stateValid &&
		string(item.prompt) &&
		Array.isArray(item.blocks) &&
		item.blocks.every(messageBlock) &&
		selection(item.selection)
	);
}

function harness(value: unknown): boolean {
	const item = record(value);
	const capabilities = record(item?.capabilities);
	const catalog = record(item?.catalog);
	return (
		!!item &&
		only(item, [
			"id",
			"label",
			"glyph",
			"icon",
			"c1",
			"c2",
			"detected",
			"capabilities",
			"catalog",
			"models",
		]) &&
		string(item.id) &&
		string(item.label) &&
		string(item.glyph) &&
		(item.icon === undefined || string(item.icon)) &&
		string(item.c1) &&
		string(item.c2) &&
		typeof item.detected === "boolean" &&
		!!capabilities &&
		only(capabilities, ["model", "effort", "resume"]) &&
		typeof capabilities.model === "boolean" &&
		typeof capabilities.effort === "boolean" &&
		typeof capabilities.resume === "boolean" &&
		!!catalog &&
		only(catalog, ["status", "diagnostics"]) &&
		(catalog.status === "ready" ||
			catalog.status === "unsupported" ||
			catalog.status === "failed") &&
		stringArray(catalog.diagnostics) &&
		Array.isArray(item.models) &&
		item.models.every((value) => {
			const model = record(value);
			return (
				!!model &&
				only(model, ["id", "label", "efforts"]) &&
				string(model.id) &&
				string(model.label) &&
				stringArray(model.efforts)
			);
		})
	);
}

function settings(value: unknown): boolean {
	const item = record(value);
	const shortcut = record(item?.shortcut);
	return (
		!!item &&
		only(item, ["appRoot", "appOrigin", "shortcut", "showFloatingButton"]) &&
		string(item.appRoot) &&
		string(item.appOrigin) &&
		!!shortcut &&
		only(shortcut, ["code", "alt", "ctrl", "shift", "meta"]) &&
		isKeyboardShortcut(shortcut) &&
		typeof item.showFloatingButton === "boolean"
	);
}

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
	const message = record(raw);
	if (!message) return fail("Expected an object.");
	if (message.v !== PROTOCOL_VERSION)
		return fail("Unsupported protocol version.");
	if (!string(message.type)) return fail("Invalid message type.");
	const allowed = SERVER_MESSAGE_KEYS[message.type];
	if (!allowed) return fail("Unknown message type.");
	if (!only(message, allowed)) return fail(`Invalid ${message.type} message.`);

	let valid = false;
	switch (message.type) {
		case "welcome":
			valid =
				string(message.daemonVersion) &&
				message.protocolVersion === PROTOCOL_VERSION &&
				string(message.projectRoot) &&
				Array.isArray(message.harnesses) &&
				message.harnesses.every(harness) &&
				(message.defaultHarnessId === null || string(message.defaultHarnessId));
			break;
		case "conversations":
			valid = Array.isArray(message.items) && message.items.every(conversation);
			break;
		case "conversation_started":
		case "config_updated":
			valid = conversation(message.conversation);
			break;
		case "conversation_resumed": {
			const resumedConversation = record(message.conversation);
			const resumedLiveTurn =
				message.liveTurn === null ? null : record(message.liveTurn);
			valid =
				conversation(resumedConversation) &&
				Array.isArray(message.turns) &&
				message.turns.every(turn) &&
				(message.liveTurn === null
					? resumedConversation?.turnState === "idle"
					: liveTurn(resumedLiveTurn) &&
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
			valid = string(message.conversationId);
			break;
		case "blocked":
			valid =
				(message.reason === "dirty_working_tree" ||
					message.reason === "busy" ||
					message.reason === "unknown_harness" ||
					message.reason === "harness_unavailable" ||
					message.reason === "outstanding_turn") &&
				(message.conversationId === undefined ||
					string(message.conversationId)) &&
				(message.files === undefined || stringArray(message.files)) &&
				string(message.message);
			break;
		case "overlay_settings":
			valid = settings(message.settings);
			break;
		case "turn_queued": {
			const live = record(message.liveTurn);
			valid =
				string(message.conversationId) &&
				liveTurn(live) &&
				live?.conversationId === message.conversationId &&
				live.turnId === null &&
				live.seq === null &&
				live.state === "queued" &&
				integer(live.queuePosition);
			break;
		}
		case "turn_started": {
			const live = record(message.liveTurn);
			valid =
				string(message.conversationId) &&
				integer(message.turnId) &&
				integer(message.seq) &&
				liveTurn(live) &&
				live?.conversationId === message.conversationId &&
				live.turnId === message.turnId &&
				live.seq === message.seq &&
				live.state === "running" &&
				live.queuePosition === null;
			break;
		}
		case "harness_output":
			valid =
				string(message.conversationId) &&
				integer(message.turnId) &&
				harnessEvent(message.event);
			break;
		case "turn_complete":
			valid =
				string(message.conversationId) &&
				integer(message.turnId) &&
				nullableString(message.checkpoint) &&
				typeof message.success === "boolean" &&
				string(message.summary);
			break;
		case "turn_error":
			valid =
				string(message.conversationId) &&
				nullableInteger(message.turnId) &&
				string(message.message);
			break;
		case "turn_cancelled":
			valid = string(message.conversationId) && nullableInteger(message.turnId);
			break;
		case "reverted":
			valid = string(message.conversationId) && string(message.checkpoint);
			break;
		case "accepted":
			valid = string(message.conversationId) && string(message.mergeCommit);
			break;
		case "error":
			valid =
				(message.conversationId === undefined ||
					string(message.conversationId)) &&
				(message.requestType === undefined ||
					requestType(message.requestType)) &&
				(message.code === undefined ||
					message.code === "merge_conflict" ||
					message.code === "unknown_conversation" ||
					message.code === "bad_message" ||
					message.code === "internal_error" ||
					message.code === "settings_unavailable" ||
					message.code === "unknown_harness" ||
					message.code === "harness_unavailable") &&
				string(message.message);
			break;
		default:
			return fail("Unknown message type.");
	}

	return valid
		? { ok: true, value: message as unknown as ServerMessage }
		: fail(`Invalid ${message.type} message.`);
}
