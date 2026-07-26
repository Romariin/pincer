import { afterEach, describe, expect, test } from "bun:test";
import type { ClientMessage } from "@pincer/core";
import { PROTOCOL_VERSION } from "@pincer/core";
import { ListView } from "../src/components/ListView";
import { usePincerStore } from "../src/state/store";
import type { PincerStore } from "../src/state/storeTypes";
import {
	conversation,
	harness,
	recordSentFrames,
	resetStore,
	welcome,
} from "./fixtures";
import { click, type Rendered, render } from "./render";

let view: Rendered | null = null;

afterEach(() => {
	view?.unmount();
	view = null;
});

function mount(): { container: HTMLElement; sent: ClientMessage[] } {
	const sent = recordSentFrames();
	view = render(<ListView />);
	return { container: view.container, sent };
}

function rowTitles(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll("button"))
		.filter((node) => node.getAttribute("aria-label") === null)
		.map((node) => node.querySelector("span.truncate")?.textContent ?? "");
}

function withConversations(patch: Partial<PincerStore>): void {
	usePincerStore.setState(patch);
}

describe("empty state", () => {
	test("invites you to start one", () => {
		resetStore();
		const { container } = mount();
		expect(container.textContent).toContain("No conversations yet.");
	});
});

describe("rows", () => {
	test("a conversation without a title falls back to its latest prompt", () => {
		resetStore();
		withConversations({
			conversations: [{ ...conversation("c1"), title: "   " }],
			threads: {
				c1: {
					messages: [
						{ id: 1, role: "user", blocks: [{ t: "md", text: "first ask" }] },
						{ id: 2, role: "user", blocks: [{ t: "md", text: "latest ask" }] },
					],
					streamingIndex: null,
					turnState: "idle",
					queuePosition: null,
					turnId: null,
					liveTurnSeq: null,
				},
			},
		});
		const { container } = mount();
		expect(rowTitles(container)).toEqual(["latest ask"]);
	});

	test("a conversation with neither title nor prompt reads as new", () => {
		resetStore();
		withConversations({
			conversations: [{ ...conversation("c1"), title: "" }],
		});
		const { container } = mount();
		expect(rowTitles(container)).toEqual(["New conversation"]);
	});

	test("a queued conversation shows its position in the queue", () => {
		resetStore();
		withConversations({ conversations: [conversation("c1", "queued", 3)] });
		const { container } = mount();
		expect(container.querySelector('[role="status"]')?.textContent).toContain(
			"Queued #3",
		);
	});

	test("a queued conversation with no position shows a bare badge", () => {
		resetStore();
		withConversations({ conversations: [conversation("c1", "queued", null)] });
		const { container } = mount();
		expect(container.querySelector('[role="status"]')?.textContent).toContain(
			"Queued",
		);
	});

	test("an idle conversation carries no status badge", () => {
		resetStore();
		withConversations({ conversations: [conversation("c1")] });
		const { container } = mount();
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	test("a conversation with no turns says so instead of naming a model", () => {
		resetStore();
		withConversations({ conversations: [conversation("c1")] });
		const { container } = mount();
		expect(container.textContent).toContain("No messages yet");
	});

	test("a conversation with turns names its Harness and model", () => {
		resetStore();
		usePincerStore.getState().applyServerMessage(welcome([harness("codex")]));
		withConversations({
			conversations: [{ ...conversation("c1"), turnCount: 2 }],
		});
		const { container } = mount();
		expect(container.textContent).toContain("codex · GPT-5");
	});
});

describe("row actions", () => {
	test("clicking a row resumes that conversation", () => {
		resetStore();
		withConversations({
			connected: true,
			conversations: [conversation("c1"), conversation("c2")],
		});
		const { container, sent } = mount();

		click(container.querySelectorAll("button")[0]);

		expect(sent).toEqual([
			{
				v: PROTOCOL_VERSION,
				type: "resume_conversation",
				conversationId: "c1",
			},
		]);
	});

	test("the delete button deletes without resuming", () => {
		resetStore();
		withConversations({ connected: true, conversations: [conversation("c1")] });
		const { container, sent } = mount();

		click(container.querySelector('[aria-label="Delete conversation"]'));

		expect(sent).toEqual([
			{
				v: PROTOCOL_VERSION,
				type: "delete_conversation",
				conversationId: "c1",
			},
		]);
	});

	test("nothing is sent while disconnected", () => {
		resetStore();
		withConversations({ conversations: [conversation("c1")] });
		const { container, sent } = mount();

		click(container.querySelectorAll("button")[0]);
		click(container.querySelector('[aria-label="Delete conversation"]'));

		expect(sent).toEqual([]);
	});
});

describe("grouping", () => {
	test("conversations are bucketed by day, most recent bucket first", () => {
		resetStore();
		const now = Date.now();
		const day = 86_400_000;
		withConversations({
			conversations: [
				{ ...conversation("today"), updatedAt: now },
				{ ...conversation("yesterday"), updatedAt: now - day },
				{ ...conversation("old"), updatedAt: now - 10 * day },
			],
		});
		const { container } = mount();

		const headings = Array.from(container.querySelectorAll("span"))
			.map((node) => node.textContent)
			.filter(
				(text) =>
					text === "TODAY" || text === "YESTERDAY" || text === "EARLIER",
			);
		expect(headings).toEqual(["TODAY", "YESTERDAY", "EARLIER"]);
	});

	test("an empty bucket prints no heading", () => {
		resetStore();
		withConversations({
			conversations: [{ ...conversation("today"), updatedAt: Date.now() }],
		});
		const { container } = mount();
		expect(container.textContent).not.toContain("YESTERDAY");
	});
});
