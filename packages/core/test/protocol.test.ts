import { describe, expect, test } from "bun:test";
import {
	PROTOCOL_VERSION,
	parseClientMessage,
	type ClientMessage,
} from "../src";

const context = {
	tag: "button",
	id: "save",
	classes: ["primary"],
	text: "Save",
	ancestry: ["button#save.primary", "body"],
};
const source = { path: "src/App.tsx", line: 10, column: 4 };
const valid: ClientMessage[] = [
	{ v: PROTOCOL_VERSION, type: "list_conversations" },
	{
		v: PROTOCOL_VERSION,
		type: "new_conversation",
		force: true,
		harnessId: "codex",
		model: "gpt-5",
		effort: "high",
	},
	{
		v: PROTOCOL_VERSION,
		type: "resume_conversation",
		conversationId: "conversation-1",
	},
	{
		v: PROTOCOL_VERSION,
		type: "set_config",
		conversationId: "conversation-1",
		model: "gpt-5",
	},
	{
		v: PROTOCOL_VERSION,
		type: "delete_conversation",
		conversationId: "conversation-1",
	},
	{
		v: PROTOCOL_VERSION,
		type: "prompt",
		conversationId: "conversation-1",
		prompt: "Change this button",
		source,
		domContext: context,
		elements: [{ source: null, domContext: context }],
	},
	{
		v: PROTOCOL_VERSION,
		type: "get_overlay_settings",
		appRoot: "/project/app",
		appOrigin: "http://localhost:5173",
	},
	{
		v: PROTOCOL_VERSION,
		type: "update_overlay_settings",
		appRoot: "/project/app",
		appOrigin: "http://localhost:5173",
		shortcut: {
			code: "KeyK",
			alt: true,
			ctrl: false,
			shift: false,
			meta: false,
		},
		showFloatingButton: false,
	},
	...(["cancel", "revert", "accept", "discard"] as const).map((type) => ({
		v: PROTOCOL_VERSION,
		type,
		conversationId: "conversation-1",
	})),
];

describe("parseClientMessage", () => {
	test("parses every client message into a typed value", () => {
		for (const message of valid) {
			expect(parseClientMessage(message)).toEqual({ ok: true, value: message });
		}
	});

	test("rejects malformed versions, discriminants, ids, config and extra fields", () => {
		const malformed: unknown[] = [
			null,
			[],
			{ v: PROTOCOL_VERSION + 1, type: "list_conversations" },
			{ v: PROTOCOL_VERSION, type: "wat" },
			{ v: PROTOCOL_VERSION, type: "list_conversations", conversationId: "x" },
			{ v: PROTOCOL_VERSION, type: "resume_conversation", conversationId: "" },
			{ v: PROTOCOL_VERSION, type: "cancel", conversationId: 42 },
			{
				v: PROTOCOL_VERSION,
				type: "new_conversation",
				force: "yes",
			},
			{
				v: PROTOCOL_VERSION,
				type: "set_config",
				conversationId: "c",
			},
			{
				v: PROTOCOL_VERSION,
				type: "set_config",
				conversationId: "c",
				model: "x".repeat(257),
			},
		];
		for (const message of malformed) {
			expect(parseClientMessage(message).ok).toBe(false);
		}
	});

	test("rejects malformed and oversized prompt context", () => {
		const prompt = (overrides: Record<string, unknown>): unknown => ({
			v: PROTOCOL_VERSION,
			type: "prompt",
			conversationId: "c",
			prompt: "change it",
			source,
			domContext: context,
			...overrides,
		});
		const malformed = [
			prompt({ prompt: "" }),
			prompt({ prompt: "x".repeat(100_001) }),
			prompt({ source: { path: "src/App.tsx", line: 0, column: 1 } }),
			prompt({ source: { path: "src/App.tsx", line: 1, column: -1 } }),
			prompt({ domContext: { ...context, ancestry: ["a", "b", "c", "d", "e", "f"] } }),
			prompt({ domContext: { ...context, classes: [4] } }),
			prompt({ domContext: { ...context, text: "x".repeat(20_001) } }),
			prompt({ elements: Array.from({ length: 51 }, () => ({ source: null, domContext: context })) }),
			prompt({ elements: [{ source: "src/App.tsx", domContext: context }] }),
		];
		for (const message of malformed) {
			expect(parseClientMessage(message).ok).toBe(false);
		}
	});

	test("rejects malformed settings payloads", () => {
		const malformed = [
			{
				v: PROTOCOL_VERSION,
				type: "get_overlay_settings",
				appRoot: "",
				appOrigin: "http://localhost",
			},
			{
				v: PROTOCOL_VERSION,
				type: "update_overlay_settings",
				appRoot: "/app",
				appOrigin: "x".repeat(2049),
				showFloatingButton: false,
			},
			{
				v: PROTOCOL_VERSION,
				type: "update_overlay_settings",
				appRoot: "/app",
				appOrigin: "http://localhost",
			},
			{
				v: PROTOCOL_VERSION,
				type: "update_overlay_settings",
				appRoot: "/app",
				appOrigin: "http://localhost",
				shortcut: { code: "Escape", alt: true, ctrl: false, shift: false, meta: false },
			},
		];
		for (const message of malformed) {
			expect(parseClientMessage(message).ok).toBe(false);
		}
	});
});
