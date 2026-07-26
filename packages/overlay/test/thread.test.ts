import { describe, expect, test } from "bun:test";
import type { MessageBlock } from "@pincer/core";
import {
	assistantMsg,
	type Cfg,
	type ConversationThread,
	conversationCfg,
	emptyThread,
	finishThread,
	mergeLiveTurn,
	replaceConversation,
	streamIntoThread,
	updateConversationTurnState,
	upsertConversation,
	userMsg,
	withSystemNote,
} from "../src/state/thread";
import { conversation, liveTurn } from "./fixtures";

const CFG: Cfg = { harnessId: "codex", model: "gpt-5", effort: "high" };

function threadWith(
	overrides: Partial<ConversationThread>,
): ConversationThread {
	return { ...emptyThread(), ...overrides };
}

function roles(thread: ConversationThread): string[] {
	return thread.messages.map((message) => message.role);
}

function requireStreaming(thread: ConversationThread): MessageBlock[] {
	const index = thread.streamingIndex;
	if (index === null) throw new Error("expected a streaming message");
	const message = thread.messages[index];
	if (!message) throw new Error(`expected a message at index ${index}`);
	return message.blocks;
}

describe("mergeLiveTurn", () => {
	test("a queued snapshot never demotes a running thread", () => {
		const running = threadWith({
			turnState: "running",
			turnId: 7,
			liveTurnSeq: 3,
		});
		const merged = mergeLiveTurn(
			running,
			liveTurn("c", {
				state: "queued",
				turnId: null,
				seq: null,
				queuePosition: 2,
			}),
		);
		expect(merged).toBe(running);
	});

	test("a snapshot from an older sequence is ignored", () => {
		const current = threadWith({
			turnState: "running",
			turnId: 9,
			liveTurnSeq: 5,
		});
		expect(mergeLiveTurn(current, liveTurn("c", { seq: 4 }))).toBe(current);
	});

	test("an optimistic queued prompt is adopted instead of duplicated", () => {
		const optimistic = threadWith({
			messages: [userMsg("write tests", 0)],
			turnState: "queued",
			turnId: null,
		});
		const merged = mergeLiveTurn(
			optimistic,
			liveTurn("c", { turnId: 4, seq: 1, prompt: "write tests" }),
		);
		expect(roles(merged)).toEqual(["user", "assistant"]);
		expect(merged.turnId).toBe(4);
		expect(merged.liveTurnSeq).toBe(1);
	});

	test("a queued thread holding a different prompt keeps both", () => {
		const optimistic = threadWith({
			messages: [userMsg("mine", 0)],
			turnState: "queued",
			turnId: null,
		});
		const merged = mergeLiveTurn(
			optimistic,
			liveTurn("c", { turnId: 4, seq: 1, prompt: "someone else's" }),
		);
		expect(merged.messages.map((message) => message.blocks)).toEqual([
			[{ t: "md", text: "mine" }],
			[{ t: "md", text: "someone else's" }],
			[],
		]);
	});

	test("a resent snapshot of the same turn replaces blocks in place", () => {
		const streaming = threadWith({
			messages: [
				userMsg("prompt", 0),
				assistantMsg([{ t: "md", text: "old" }], CFG),
			],
			streamingIndex: 1,
			turnState: "running",
			turnId: 4,
			liveTurnSeq: 1,
		});
		const merged = mergeLiveTurn(
			streaming,
			liveTurn("c", {
				turnId: 4,
				seq: 1,
				prompt: "prompt",
				blocks: [{ t: "md", text: "old and new" }],
			}),
		);
		expect(roles(merged)).toEqual(["user", "assistant"]);
		expect(requireStreaming(merged)).toEqual([
			{ t: "md", text: "old and new" },
		]);
	});

	test("a queued snapshot opens no assistant message", () => {
		const merged = mergeLiveTurn(
			emptyThread(),
			liveTurn("c", {
				state: "queued",
				turnId: null,
				seq: null,
				queuePosition: 3,
			}),
		);
		expect(roles(merged)).toEqual(["user"]);
		expect(merged.streamingIndex).toBeNull();
		expect(merged.queuePosition).toBe(3);
	});
});

describe("streamIntoThread", () => {
	const append = (block: MessageBlock) => (blocks: MessageBlock[]) => [
		...blocks,
		block,
	];

	test("rejects a delta for a thread that is no longer running", () => {
		expect(
			streamIntoThread(emptyThread(), 4, CFG, append({ t: "md", text: "x" })),
		).toBeNull();
	});

	test("rejects a delta from a superseded turn", () => {
		const running = threadWith({ turnState: "running", turnId: 4 });
		expect(
			streamIntoThread(running, 3, CFG, append({ t: "md", text: "x" })),
		).toBeNull();
	});

	test("opens an assistant message when the turn has produced nothing yet", () => {
		const running = threadWith({
			messages: [userMsg("prompt", 0)],
			turnState: "running",
			turnId: 4,
		});
		const next = streamIntoThread(
			running,
			4,
			CFG,
			append({ t: "md", text: "first" }),
		);
		if (!next) throw new Error("expected a thread");
		expect(roles(next)).toEqual(["user", "assistant"]);
		expect(next.streamingIndex).toBe(1);
		expect(next.messages[1]?.meta).toEqual(CFG);
		expect(requireStreaming(next)).toEqual([{ t: "md", text: "first" }]);
	});

	test("appends to the open assistant message without adding another", () => {
		const running = threadWith({
			messages: [
				userMsg("prompt", 0),
				assistantMsg([{ t: "md", text: "a" }], CFG),
			],
			streamingIndex: 1,
			turnState: "running",
			turnId: 4,
		});
		const next = streamIntoThread(
			running,
			4,
			CFG,
			append({ t: "tool", name: "Read", detail: "a.ts" }),
		);
		if (!next) throw new Error("expected a thread");
		expect(roles(next)).toEqual(["user", "assistant"]);
		expect(requireStreaming(next)).toEqual([
			{ t: "md", text: "a" },
			{ t: "tool", name: "Read", detail: "a.ts" },
		]);
	});
});

describe("finishThread", () => {
	test("drops a streaming assistant message that never produced output", () => {
		const finished = finishThread(
			threadWith({
				messages: [userMsg("prompt", 0), assistantMsg([], CFG)],
				streamingIndex: 1,
				turnState: "running",
				turnId: 4,
				liveTurnSeq: 1,
			}),
		);
		expect(roles(finished)).toEqual(["user"]);
		expect(finished).toMatchObject({
			streamingIndex: null,
			turnState: "idle",
			queuePosition: null,
			turnId: null,
			liveTurnSeq: null,
		});
	});

	test("keeps a streaming assistant message that produced output", () => {
		const finished = finishThread(
			threadWith({
				messages: [
					userMsg("prompt", 0),
					assistantMsg([{ t: "md", text: "a" }], CFG),
				],
				streamingIndex: 1,
				turnState: "running",
				turnId: 4,
			}),
		);
		expect(roles(finished)).toEqual(["user", "assistant"]);
	});
});

test("withSystemNote appends a system message and keeps the turn fields", () => {
	const noted = withSystemNote(
		threadWith({ turnState: "running", turnId: 4 }),
		"Working tree is dirty.",
	);
	expect(noted.messages).toHaveLength(1);
	expect(noted.messages[0]).toMatchObject({
		role: "system",
		blocks: [{ t: "md", text: "Working tree is dirty." }],
	});
	expect(noted.turnState).toBe("running");
});

describe("conversation list helpers", () => {
	test("upsertConversation moves an existing row to the front", () => {
		const list = [conversation("a"), conversation("b")];
		const next = upsertConversation(list, conversation("b", "running"));
		expect(next.map((item) => item.id)).toEqual(["b", "a"]);
		expect(next[0]?.turnState).toBe("running");
	});

	test("replaceConversation keeps position, prepends an unknown row", () => {
		const list = [conversation("a"), conversation("b")];
		expect(
			replaceConversation(list, conversation("b", "queued", 1)).map(
				(item) => item.id,
			),
		).toEqual(["a", "b"]);
		expect(
			replaceConversation(list, conversation("c")).map((item) => item.id),
		).toEqual(["c", "a", "b"]);
	});

	test("updateConversationTurnState touches only the named conversation", () => {
		const next = updateConversationTurnState(
			[conversation("a", "running"), conversation("b", "running")],
			"a",
			"queued",
			2,
		);
		expect(next[0]).toMatchObject({ turnState: "queued", queuePosition: 2 });
		expect(next[1]).toMatchObject({
			turnState: "running",
			queuePosition: null,
		});
	});

	test("conversationCfg projects the command-bar triple", () => {
		expect(conversationCfg(conversation("a"))).toEqual(CFG);
	});
});
