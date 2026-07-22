import { describe, expect, test } from "bun:test";
import {
	PROTOCOL_VERSION,
	parseClientMessage,
	parseServerMessage,
	type ClientMessage,
	type ConversationSummary,
	type HarnessDescriptor,
	type LiveTurnSnapshot,
	type OverlaySettings,
	type ServerMessage,
	type TurnSummary,
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

describe("parseServerMessage", () => {
	const descriptor: HarnessDescriptor = {
		id: "codex",
		label: "Codex",
		glyph: ">_",
		c1: "#111",
		c2: "#222",
		detected: true,
		capabilities: { model: true, effort: true, resume: true },
		catalog: { status: "ready", diagnostics: [] },
		models: [{ id: "gpt-5", label: "GPT-5", efforts: ["high"] }],
	};
	const summary: ConversationSummary = {
		id: "conversation-1",
		branch: "pincer/conversation-1",
		status: "active",
		createdAt: 1,
		updatedAt: 2,
		turnCount: 1,
		title: "Prompt",
		harnessId: "codex",
		model: "gpt-5",
		effort: "high",
		turnState: "idle",
		queuePosition: null,
	};
	const runningSummary: ConversationSummary = {
		...summary,
		turnState: "running",
		queuePosition: null,
	};
	const selection = { harnessId: "codex", model: "gpt-5", effort: "high" };
	const queued: LiveTurnSnapshot = {
		conversationId: summary.id,
		turnId: null,
		seq: null,
		state: "queued",
		queuePosition: 0,
		prompt: "Prompt",
		blocks: [],
		selection,
	};
	const running: LiveTurnSnapshot = {
		...queued,
		turnId: 1,
		seq: 0,
		state: "running",
		queuePosition: null,
	};
	const turn: TurnSummary = {
		id: 1,
		seq: 0,
		prompt: "Prompt",
		checkpoint: "abc123",
		status: "complete",
		createdAt: 1,
		output: "Done",
		blocks: [{ t: "md", text: "Done" }],
	};
	const overlaySettings: OverlaySettings = {
		appRoot: "/project",
		appOrigin: "http://localhost:5173",
		shortcut: {
			code: "KeyP",
			alt: true,
			ctrl: false,
			shift: true,
			meta: false,
		},
		showFloatingButton: true,
	};
	const welcome: ServerMessage = {
		v: PROTOCOL_VERSION,
		type: "welcome",
		daemonVersion: "0.1.0",
		protocolVersion: PROTOCOL_VERSION,
		projectRoot: "/project",
		harnesses: [descriptor],
		defaultHarnessId: descriptor.id,
	};
	const valid: ServerMessage[] = [
		welcome,
		{ v: PROTOCOL_VERSION, type: "conversations", items: [summary] },
		{ v: PROTOCOL_VERSION, type: "conversation_started", conversation: summary },
		{
			v: PROTOCOL_VERSION,
			type: "conversation_resumed",
			conversation: runningSummary,
			turns: [turn],
			liveTurn: running,
		},
		{ v: PROTOCOL_VERSION, type: "config_updated", conversation: summary },
		{ v: PROTOCOL_VERSION, type: "deleted", conversationId: summary.id },
		{
			v: PROTOCOL_VERSION,
			type: "blocked",
			reason: "dirty_working_tree",
			conversationId: summary.id,
			files: ["src/App.tsx"],
			message: "Dirty tree",
		},
		{ v: PROTOCOL_VERSION, type: "overlay_settings", settings: overlaySettings },
		{ v: PROTOCOL_VERSION, type: "turn_queued", conversationId: summary.id, liveTurn: queued },
		{
			v: PROTOCOL_VERSION,
			type: "turn_started",
			conversationId: summary.id,
			turnId: 1,
			seq: 0,
			liveTurn: running,
		},
		{
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: summary.id,
			turnId: 1,
			event: { kind: "text", text: "Working" },
		},
		{
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: summary.id,
			turnId: 1,
			event: { kind: "tool", name: "Read", detail: "src/App.tsx" },
		},
		{
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: summary.id,
			turnId: 1,
			event: { kind: "diff", file: "src/App.tsx", hunks: [{ type: "add", text: "+x" }] },
		},
		{
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: summary.id,
			turnId: 1,
			event: { kind: "session", token: "session-1" },
		},
		{
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: summary.id,
			turnId: 1,
			event: { kind: "result", success: true, summary: "Done" },
		},
		{
			v: PROTOCOL_VERSION,
			type: "turn_complete",
			conversationId: summary.id,
			turnId: 1,
			checkpoint: "abc123",
			success: true,
			summary: "Done",
		},
		{
			v: PROTOCOL_VERSION,
			type: "turn_error",
			conversationId: summary.id,
			turnId: null,
			message: "Failed",
		},
		{ v: PROTOCOL_VERSION, type: "turn_cancelled", conversationId: summary.id, turnId: null },
		{ v: PROTOCOL_VERSION, type: "reverted", conversationId: summary.id, checkpoint: "abc123" },
		{ v: PROTOCOL_VERSION, type: "accepted", conversationId: summary.id, mergeCommit: "def456" },
		{ v: PROTOCOL_VERSION, type: "discarded", conversationId: summary.id },
		{
			v: PROTOCOL_VERSION,
			type: "error",
			conversationId: summary.id,
			code: "unknown_conversation",
			message: "Unknown conversation",
		},
	];

	test("parses every valid daemon frame into a typed value", () => {
		for (const message of valid) {
			expect(parseServerMessage(message)).toEqual({ ok: true, value: message });
		}
	});

	test("rejects incompatible, unknown and structurally malformed daemon frames", () => {
		const malformed: unknown[] = [
			null,
			{ ...welcome, v: PROTOCOL_VERSION + 1 },
			{ ...welcome, protocolVersion: PROTOCOL_VERSION + 1 },
			{ ...welcome, unexpected: true },
			{ ...welcome, harnesses: [{ ...descriptor, unexpected: true }] },
			{ v: PROTOCOL_VERSION, type: "unknown" },
			{ v: PROTOCOL_VERSION, type: "conversations", items: [{}] },
			{
				v: PROTOCOL_VERSION,
				type: "conversations",
				items: [{ ...summary, unexpected: true }],
			},
			{
				v: PROTOCOL_VERSION,
				type: "conversation_resumed",
				conversation: runningSummary,
				turns: [turn],
				liveTurn: { ...running, conversationId: "conversation-2" },
			},
			{
				v: PROTOCOL_VERSION,
				type: "conversation_resumed",
				conversation: runningSummary,
				turns: [turn],
				liveTurn: { ...running, turnId: null },
			},
			{
				v: PROTOCOL_VERSION,
				type: "harness_output",
				conversationId: "conversation-1",
				turnId: -1,
				event: { kind: "text", text: "invalid id" },
			},
			{
				v: PROTOCOL_VERSION,
				type: "harness_output",
				conversationId: "conversation-1",
				turnId: 1,
				event: { kind: "text", text: 42 },
			},
			{
				v: PROTOCOL_VERSION,
				type: "turn_started",
				conversationId: "conversation-1",
				turnId: 1,
				seq: 0,
				liveTurn: {
					conversationId: "conversation-2",
					turnId: null,
					seq: null,
					state: "queued",
					queuePosition: 0,
					prompt: "prompt",
					blocks: [],
					selection: { harnessId: "codex", model: "", effort: "" },
				},
			},
		];
		for (const message of malformed) {
			expect(parseServerMessage(message).ok).toBe(false);
		}
	});
});
