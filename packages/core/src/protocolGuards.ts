import { isKeyboardShortcut } from "./protocol";
import {
	asRecord,
	hasOnlyKeys,
	isFiniteNumber,
	isNonNegativeInteger,
	isNullableString,
	isString,
	isStringArray,
} from "./valueGuards";

export function isRequestType(value: unknown): boolean {
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

export function isMessageBlock(value: unknown): boolean {
	const block = asRecord(value);
	if (!block || !isString(block.t)) return false;
	switch (block.t) {
		case "md":
			return hasOnlyKeys(block, ["t", "text"]) && isString(block.text);
		case "tool":
			return (
				hasOnlyKeys(block, ["t", "name", "detail"]) &&
				isString(block.name) &&
				(block.detail === undefined || isString(block.detail))
			);
		case "diff":
			return (
				hasOnlyKeys(block, ["t", "file", "hunks"]) &&
				isString(block.file) &&
				Array.isArray(block.hunks) &&
				block.hunks.every((value) => {
					const hunk = asRecord(value);
					return (
						!!hunk &&
						hasOnlyKeys(hunk, ["type", "text"]) &&
						(hunk.type === "add" ||
							hunk.type === "del" ||
							hunk.type === "ctx") &&
						isString(hunk.text)
					);
				})
			);
		default:
			return false;
	}
}

export function isHarnessEvent(value: unknown): boolean {
	const event = asRecord(value);
	if (!event || !isString(event.kind)) return false;
	switch (event.kind) {
		case "status":
		case "text":
			return hasOnlyKeys(event, ["kind", "text"]) && isString(event.text);
		case "tool":
			return (
				hasOnlyKeys(event, ["kind", "name", "detail"]) &&
				isString(event.name) &&
				(event.detail === undefined || isString(event.detail))
			);
		case "diff":
			return (
				hasOnlyKeys(event, ["kind", "file", "hunks"]) &&
				isMessageBlock({ t: "diff", file: event.file, hunks: event.hunks })
			);
		case "session":
			return hasOnlyKeys(event, ["kind", "token"]) && isString(event.token);
		case "result":
			return (
				hasOnlyKeys(event, ["kind", "success", "summary"]) &&
				typeof event.success === "boolean" &&
				(event.summary === undefined || isString(event.summary))
			);
		default:
			return false;
	}
}

export function isConversation(value: unknown): boolean {
	const item = asRecord(value);
	const stateValid =
		item?.turnState === "queued"
			? isNonNegativeInteger(item.queuePosition)
			: (item?.turnState === "idle" || item?.turnState === "running") &&
				item.queuePosition === null;
	return (
		!!item &&
		hasOnlyKeys(item, [
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
		isString(item.id) &&
		isString(item.branch) &&
		(item.status === "active" ||
			item.status === "accepted" ||
			item.status === "discarded") &&
		isFiniteNumber(item.createdAt) &&
		isFiniteNumber(item.updatedAt) &&
		isNonNegativeInteger(item.turnCount) &&
		isNullableString(item.title) &&
		isString(item.harnessId) &&
		isString(item.model) &&
		isString(item.effort) &&
		stateValid
	);
}

export function isTurn(value: unknown): boolean {
	const item = asRecord(value);
	return (
		!!item &&
		hasOnlyKeys(item, [
			"id",
			"seq",
			"prompt",
			"checkpoint",
			"status",
			"createdAt",
			"output",
			"blocks",
		]) &&
		isNonNegativeInteger(item.id) &&
		isNonNegativeInteger(item.seq) &&
		isString(item.prompt) &&
		isNullableString(item.checkpoint) &&
		(item.status === "running" ||
			item.status === "complete" ||
			item.status === "error" ||
			item.status === "cancelled" ||
			item.status === "reverted") &&
		isFiniteNumber(item.createdAt) &&
		isString(item.output) &&
		Array.isArray(item.blocks) &&
		item.blocks.every(isMessageBlock)
	);
}

export function isHarnessSelection(value: unknown): boolean {
	const item = asRecord(value);
	return (
		!!item &&
		hasOnlyKeys(item, ["harnessId", "model", "effort"]) &&
		isString(item.harnessId) &&
		isString(item.model) &&
		isString(item.effort)
	);
}

export function isLiveTurn(value: unknown): boolean {
	const item = asRecord(value);
	const stateValid =
		item?.state === "queued"
			? item.turnId === null &&
				item.seq === null &&
				isNonNegativeInteger(item.queuePosition)
			: item?.state === "running" &&
				isNonNegativeInteger(item.turnId) &&
				isNonNegativeInteger(item.seq) &&
				item.queuePosition === null;
	return (
		!!item &&
		hasOnlyKeys(item, [
			"conversationId",
			"turnId",
			"seq",
			"state",
			"queuePosition",
			"prompt",
			"blocks",
			"selection",
		]) &&
		isString(item.conversationId) &&
		stateValid &&
		isString(item.prompt) &&
		Array.isArray(item.blocks) &&
		item.blocks.every(isMessageBlock) &&
		isHarnessSelection(item.selection)
	);
}

export function isHarnessDescriptor(value: unknown): boolean {
	const item = asRecord(value);
	const capabilities = asRecord(item?.capabilities);
	const catalog = asRecord(item?.catalog);
	return (
		!!item &&
		hasOnlyKeys(item, [
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
		isString(item.id) &&
		isString(item.label) &&
		isString(item.glyph) &&
		(item.icon === undefined || isString(item.icon)) &&
		isString(item.c1) &&
		isString(item.c2) &&
		typeof item.detected === "boolean" &&
		!!capabilities &&
		hasOnlyKeys(capabilities, ["model", "effort", "resume"]) &&
		typeof capabilities.model === "boolean" &&
		typeof capabilities.effort === "boolean" &&
		typeof capabilities.resume === "boolean" &&
		!!catalog &&
		hasOnlyKeys(catalog, ["status", "diagnostics"]) &&
		(catalog.status === "ready" ||
			catalog.status === "unsupported" ||
			catalog.status === "failed") &&
		isStringArray(catalog.diagnostics) &&
		Array.isArray(item.models) &&
		item.models.every((value) => {
			const model = asRecord(value);
			return (
				!!model &&
				hasOnlyKeys(model, ["id", "label", "efforts"]) &&
				isString(model.id) &&
				isString(model.label) &&
				isStringArray(model.efforts)
			);
		})
	);
}

export function isOverlaySettings(value: unknown): boolean {
	const item = asRecord(value);
	const shortcut = asRecord(item?.shortcut);
	return (
		!!item &&
		hasOnlyKeys(item, [
			"appRoot",
			"appOrigin",
			"shortcut",
			"showFloatingButton",
		]) &&
		isString(item.appRoot) &&
		isString(item.appOrigin) &&
		!!shortcut &&
		hasOnlyKeys(shortcut, ["code", "alt", "ctrl", "shift", "meta"]) &&
		isKeyboardShortcut(shortcut) &&
		typeof item.showFloatingButton === "boolean"
	);
}
