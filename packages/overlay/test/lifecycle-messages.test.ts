import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "@pincer/core";
import { PROTOCOL_VERSION } from "@pincer/core";
import { usePincerStore } from "../src/state/store";
import {
	apply,
	content,
	conversation,
	liveTurn,
	pendingPrompt,
	recordSentFrames,
	requireThread,
	resetStore,
	resume,
} from "./fixtures";

const store = () => usePincerStore.getState();

const started = (id: string): ServerMessage => ({
	v: PROTOCOL_VERSION,
	type: "conversation_started",
	conversation: conversation(id),
});

/** `accepted` carries a merge commit, `discarded` does not. */
const settled = (
	type: "accepted" | "discarded",
	conversationId: string,
): ServerMessage =>
	type === "accepted"
		? { v: PROTOCOL_VERSION, type, conversationId, mergeCommit: "abc123" }
		: { v: PROTOCOL_VERSION, type, conversationId };

const blocked = (
	message: string,
	reason: Extract<ServerMessage, { type: "blocked" }>["reason"],
	conversationId?: string,
): ServerMessage => ({
	v: PROTOCOL_VERSION,
	type: "blocked",
	reason,
	message,
	...(conversationId ? { conversationId } : {}),
});

describe("conversation_started", () => {
	test("replays the pending prompt exactly once and shows it optimistically", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		const sent = recordSentFrames();
		store().submitPrompt(pendingPrompt("build the thing", 2));
		expect(sent.map((frame) => frame.type)).toEqual(["new_conversation"]);

		apply(started("c1"));

		expect(store()).toMatchObject({
			view: "chat",
			conversationId: "c1",
			pendingPrompt: null,
		});
		expect(content("c1")).toEqual([
			{ role: "user", blocks: [{ t: "md", text: "build the thing" }] },
		]);
		expect(requireThread("c1").messages[0]?.elementCount).toBe(2);
		expect(requireThread("c1").turnState).toBe("queued");
		expect(sent.map((frame) => frame.type)).toEqual([
			"new_conversation",
			"prompt",
		]);
	});

	test("marks the new list row queued while the replayed prompt is outstanding", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		recordSentFrames();
		store().submitPrompt(pendingPrompt("go"));

		apply(started("c1"));

		expect(store().conversations[0]).toMatchObject({
			id: "c1",
			turnState: "queued",
			queuePosition: null,
		});
	});

	test("without a pending prompt it only opens the conversation", () => {
		resetStore();
		const sent = recordSentFrames();

		apply(started("c1"));

		expect(store()).toMatchObject({ view: "chat", conversationId: "c1" });
		expect(content("c1")).toEqual([]);
		expect(sent).toEqual([]);
		expect(store().conversations[0]?.turnState).toBe("idle");
	});

	test("a thread that is no longer idle is never given a second prompt", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		resume(
			conversation("c1", "running"),
			[],
			liveTurn("c1", { turnId: 3, seq: 1, prompt: "already running" }),
		);
		usePincerStore.setState({ pendingPrompt: pendingPrompt("late") });
		const sent = recordSentFrames();

		apply(started("c1"));

		expect(
			content("c1").filter((message) => message.role === "user"),
		).toHaveLength(1);
		expect(store().pendingPrompt).toBeNull();
		expect(sent.map((frame) => frame.type)).toEqual(["prompt"]);
	});
});

describe("blocked", () => {
	test("a rejected submission ends the turn and unlocks the composer", () => {
		resetStore();
		resume(conversation("c1"));
		store().queueUserMessage("c1", "make it blue", 0);
		usePincerStore.setState({ configPending: { c1: true } });

		apply(blocked("Working tree is dirty.", "dirty_working_tree", "c1"));

		expect(requireThread("c1").turnState).toBe("idle");
		expect(content("c1")).toEqual([
			{ role: "user", blocks: [{ t: "md", text: "make it blue" }] },
			{ role: "system", blocks: [{ t: "md", text: "Working tree is dirty." }] },
		]);
		expect(store().conversations[0]).toMatchObject({
			turnState: "idle",
			queuePosition: null,
		});
		expect(store().configPending).toEqual({});
	});

	test("an outstanding-turn rejection notes the reason without stopping the run", () => {
		resetStore();
		resume(
			conversation("c1", "running"),
			[],
			liveTurn("c1", { turnId: 5, seq: 2, blocks: [{ t: "md", text: "out" }] }),
		);

		apply(blocked("A turn is already running.", "outstanding_turn", "c1"));

		expect(requireThread("c1").turnState).toBe("running");
		expect(store().conversations[0]?.turnState).toBe("running");
		expect(content("c1").at(-1)).toEqual({
			role: "system",
			blocks: [{ t: "md", text: "A turn is already running." }],
		});
	});

	test("a correlated rejection keeps an unrelated pending creation alive", () => {
		resetStore();
		resume(conversation("c1"));
		usePincerStore.setState({ pendingPrompt: pendingPrompt("elsewhere") });

		apply(blocked("Working tree is dirty.", "dirty_working_tree", "c1"));

		expect(store().pendingPrompt?.prompt).toBe("elsewhere");
	});

	test("an uncorrelated rejection notes it on the open conversation", () => {
		resetStore();
		resume(conversation("c1"));
		usePincerStore.setState({ pendingPrompt: pendingPrompt("new one") });

		apply(blocked("No Harness is installed.", "unknown_harness"));

		expect(content("c1").at(-1)).toEqual({
			role: "system",
			blocks: [{ t: "md", text: "No Harness is installed." }],
		});
		expect(store().pendingPrompt).toBeNull();
	});

	test("an uncorrelated rejection with no open conversation only releases the prompt", () => {
		resetStore();
		usePincerStore.setState({ pendingPrompt: pendingPrompt("new one") });

		apply(blocked("No Harness is installed.", "unknown_harness"));

		expect(store()).toMatchObject({
			pendingPrompt: null,
			view: "list",
			threads: {},
		});
	});
});

describe("deleted", () => {
	test("deleting the open conversation falls back to the list", () => {
		resetStore();
		resume(conversation("other"));
		resume(conversation("c1"));
		usePincerStore.setState({ recordingShortcut: true });

		apply({ v: PROTOCOL_VERSION, type: "deleted", conversationId: "c1" });

		expect(store()).toMatchObject({
			view: "list",
			conversationId: null,
			recordingShortcut: false,
		});
		expect(store().threads.c1).toBeUndefined();
		expect(store().conversations.map((item) => item.id)).toEqual(["other"]);
	});

	test("deleting a hidden conversation leaves the open one on screen", () => {
		resetStore();
		resume(conversation("hidden"));
		resume(conversation("visible"));

		apply({ v: PROTOCOL_VERSION, type: "deleted", conversationId: "hidden" });

		expect(store()).toMatchObject({ view: "chat", conversationId: "visible" });
		expect(store().threads.hidden).toBeUndefined();
		expect(store().threads.visible).toBeDefined();
	});
});

describe("accepted, discarded and reverted", () => {
	test.each(["accepted", "discarded"] as const)(
		"%s closes the branch it was viewing and refreshes the list",
		(type) => {
			resetStore();
			resume(conversation("c1"));
			usePincerStore.setState({ recordingShortcut: true });
			const sent = recordSentFrames();

			apply(settled(type, "c1"));

			expect(store()).toMatchObject({
				view: "list",
				conversationId: null,
				recordingShortcut: false,
			});
			expect(sent.map((frame) => frame.type)).toEqual(["list_conversations"]);
		},
	);

	test.each(["accepted", "discarded"] as const)(
		"%s on a hidden conversation keeps the current view",
		(type) => {
			resetStore();
			resume(conversation("hidden"));
			resume(conversation("visible"));
			const sent = recordSentFrames();

			apply(settled(type, "hidden"));

			expect(store()).toMatchObject({
				view: "chat",
				conversationId: "visible",
			});
			expect(sent.map((frame) => frame.type)).toEqual(["list_conversations"]);
		},
	);

	test("reverted only refreshes the list", () => {
		resetStore();
		resume(conversation("c1"));
		const before = structuredClone(requireThread("c1"));
		const sent = recordSentFrames();

		apply({
			v: PROTOCOL_VERSION,
			type: "reverted",
			conversationId: "c1",
			checkpoint: "checkpoint-1",
		});

		expect(store()).toMatchObject({ view: "chat", conversationId: "c1" });
		expect(requireThread("c1")).toEqual(before);
		expect(sent.map((frame) => frame.type)).toEqual(["list_conversations"]);
	});
});
