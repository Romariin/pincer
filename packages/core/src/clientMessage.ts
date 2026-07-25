import { PROTOCOL_VERSION } from "./constants";
import type { DomContext } from "./dom";
import type {
	ClientMessage,
	ConversationConfig,
	KeyboardShortcut,
	PromptElement,
} from "./protocol";
import { isKeyboardShortcut } from "./protocol";
import type { SourceLocation } from "./source";

const MAX_ID = 128;
const MAX_CONFIG = 256;
const MAX_PROMPT = 100_000;
const MAX_PATH = 4_096;
const MAX_ORIGIN = 2_048;
const MAX_TAG = 128;
const MAX_DOM_ID = 512;
const MAX_CLASS = 256;
const MAX_CLASSES = 128;
const MAX_TEXT = 20_000;
const MAX_ANCESTRY_ITEM = 1_024;
const MAX_ANCESTRY = 5;
const MAX_ELEMENTS = 50;

export const MAX_CLIENT_FRAME_BYTES = 1_048_576;

export type ClientMessageParseResult =
	| { ok: true; value: ClientMessage }
	| { ok: false; error: string };

function fail(error: string): ClientMessageParseResult {
	return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.length > 0) &&
		value.length <= max
	);
}

function isConversationId(value: unknown): value is string {
	return boundedString(value, MAX_ID);
}

function parseConfig(
	value: Record<string, unknown>,
	requirePatch: boolean,
): ConversationConfig | null {
	const config: ConversationConfig = {};
	let count = 0;
	if (Object.hasOwn(value, "harnessId")) {
		if (!boundedString(value.harnessId, MAX_CONFIG, true)) return null;
		config.harnessId = value.harnessId;
		count += 1;
	}
	if (Object.hasOwn(value, "model")) {
		if (!boundedString(value.model, MAX_CONFIG, true)) return null;
		config.model = value.model;
		count += 1;
	}
	if (Object.hasOwn(value, "effort")) {
		if (!boundedString(value.effort, MAX_CONFIG, true)) return null;
		config.effort = value.effort;
		count += 1;
	}
	return requirePatch && count === 0 ? null : config;
}

function parseSource(value: unknown): SourceLocation | null | undefined {
	if (value === null) return null;
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["path", "line", "column"]) ||
		!boundedString(value.path, MAX_PATH) ||
		!Number.isSafeInteger(value.line) ||
		!Number.isSafeInteger(value.column) ||
		Number(value.line) < 1 ||
		Number(value.column) < 0
	) {
		return undefined;
	}
	return { path: value.path, line: Number(value.line), column: Number(value.column) };
}

function boundedStringArray(
	value: unknown,
	maxItems: number,
	maxItemLength: number,
): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= maxItems &&
		value.every((item) => boundedString(item, maxItemLength, true))
	);
}

function parseDomContext(value: unknown): DomContext | null {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["tag", "id", "classes", "text", "ancestry"]) ||
		!boundedString(value.tag, MAX_TAG) ||
		!(value.id === null || boundedString(value.id, MAX_DOM_ID, true)) ||
		!boundedStringArray(value.classes, MAX_CLASSES, MAX_CLASS) ||
		!(value.text === null || boundedString(value.text, MAX_TEXT, true)) ||
		!boundedStringArray(value.ancestry, MAX_ANCESTRY, MAX_ANCESTRY_ITEM)
	) {
		return null;
	}
	return {
		tag: value.tag,
		id: value.id,
		classes: value.classes,
		text: value.text,
		ancestry: value.ancestry,
	};
}

function parseElement(value: unknown): PromptElement | null {
	if (!isRecord(value) || !hasOnlyKeys(value, ["source", "domContext"])) {
		return null;
	}
	const source = parseSource(value.source);
	const domContext = parseDomContext(value.domContext);
	if (source === undefined || domContext === null) return null;
	return { source, domContext };
}

function parseElements(value: unknown): PromptElement[] | null {
	if (!Array.isArray(value) || value.length > MAX_ELEMENTS) return null;
	const elements: PromptElement[] = [];
	for (const item of value) {
		const element = parseElement(item);
		if (!element) return null;
		elements.push(element);
	}
	return elements;
}

function parseShortcut(value: unknown): KeyboardShortcut | null {
	if (!isRecord(value) || !hasOnlyKeys(value, ["code", "alt", "ctrl", "shift", "meta"])) {
		return null;
	}
	return isKeyboardShortcut(value) ? value : null;
}

export function parseClientMessage(raw: unknown): ClientMessageParseResult {
	if (!isRecord(raw)) return fail("Expected an object.");
	if (raw.v !== PROTOCOL_VERSION) return fail("Unsupported protocol version.");
	if (typeof raw.type !== "string") return fail("Invalid message type.");

	switch (raw.type) {
		case "list_conversations":
			return hasOnlyKeys(raw, ["v", "type"])
				? { ok: true, value: { v: PROTOCOL_VERSION, type: raw.type } }
				: fail("Invalid list_conversations message.");
		case "new_conversation": {
			if (!hasOnlyKeys(raw, ["v", "type", "force", "harnessId", "model", "effort"])) {
				return fail("Invalid new_conversation message.");
			}
			if (Object.hasOwn(raw, "force") && typeof raw.force !== "boolean") {
				return fail("Invalid new_conversation force.");
			}
			const config = parseConfig(raw, false);
			if (!config) return fail("Invalid conversation config.");
			return {
				ok: true,
				value: {
					v: PROTOCOL_VERSION,
					type: raw.type,
					...(typeof raw.force === "boolean" ? { force: raw.force } : {}),
					...config,
				},
			};
		}
		case "resume_conversation":
		case "delete_conversation":
		case "cancel":
		case "revert":
		case "accept":
		case "discard":
			if (
				!hasOnlyKeys(raw, ["v", "type", "conversationId"]) ||
				!isConversationId(raw.conversationId)
			) {
				return fail(`Invalid ${raw.type} message.`);
			}
			return {
				ok: true,
				value: { v: PROTOCOL_VERSION, type: raw.type, conversationId: raw.conversationId },
			};
		case "set_config": {
			if (
				!hasOnlyKeys(raw, ["v", "type", "conversationId", "harnessId", "model", "effort"]) ||
				!isConversationId(raw.conversationId)
			) {
				return fail("Invalid set_config message.");
			}
			const config = parseConfig(raw, true);
			if (!config) return fail("Invalid conversation config.");
			return {
				ok: true,
				value: {
					v: PROTOCOL_VERSION,
					type: raw.type,
					conversationId: raw.conversationId,
					...config,
				},
			};
		}
		case "prompt": {
			if (
				!hasOnlyKeys(raw, [
					"v",
					"type",
					"conversationId",
					"prompt",
					"source",
					"domContext",
					"elements",
				]) ||
				!isConversationId(raw.conversationId) ||
				!boundedString(raw.prompt, MAX_PROMPT)
			) {
				return fail("Invalid prompt message.");
			}
			const source = parseSource(raw.source);
			const domContext = parseDomContext(raw.domContext);
			const elements = Object.hasOwn(raw, "elements")
				? parseElements(raw.elements)
				: undefined;
			if (source === undefined || domContext === null || elements === null) {
				return fail("Invalid prompt context.");
			}
			return {
				ok: true,
				value: {
					v: PROTOCOL_VERSION,
					type: raw.type,
					conversationId: raw.conversationId,
					prompt: raw.prompt,
					source,
					domContext,
					...(elements === undefined ? {} : { elements }),
				},
			};
		}
		case "get_overlay_settings":
			if (
				!hasOnlyKeys(raw, ["v", "type", "appRoot", "appOrigin"]) ||
				!boundedString(raw.appRoot, MAX_PATH) ||
				!boundedString(raw.appOrigin, MAX_ORIGIN)
			) {
				return fail("Invalid overlay settings request.");
			}
			return {
				ok: true,
				value: {
					v: PROTOCOL_VERSION,
					type: raw.type,
					appRoot: raw.appRoot,
					appOrigin: raw.appOrigin,
				},
			};
		case "update_overlay_settings": {
			if (
				!hasOnlyKeys(raw, [
					"v",
					"type",
					"appRoot",
					"appOrigin",
					"shortcut",
					"showFloatingButton",
				]) ||
				!boundedString(raw.appRoot, MAX_PATH) ||
				!boundedString(raw.appOrigin, MAX_ORIGIN)
			) {
				return fail("Invalid overlay settings update.");
			}
			const hasShortcut = Object.hasOwn(raw, "shortcut");
			const hasFloatingButton = Object.hasOwn(raw, "showFloatingButton");
			const shortcut = hasShortcut ? parseShortcut(raw.shortcut) : undefined;
			if (
				(!hasShortcut && !hasFloatingButton) ||
				(hasShortcut && shortcut === null) ||
				(hasFloatingButton && typeof raw.showFloatingButton !== "boolean")
			) {
				return fail("Invalid overlay settings update.");
			}
			return {
				ok: true,
				value: {
					v: PROTOCOL_VERSION,
					type: raw.type,
					appRoot: raw.appRoot,
					appOrigin: raw.appOrigin,
					...(shortcut ? { shortcut } : {}),
					...(typeof raw.showFloatingButton === "boolean"
						? { showFloatingButton: raw.showFloatingButton }
						: {}),
				},
			};
		}
		default:
			return fail("Unknown message type.");
	}
}
