import { afterEach, describe, expect, test } from "bun:test";
import type { ClientMessage } from "@pincer/core";
import { PROTOCOL_VERSION } from "@pincer/core";
import { Composer } from "../src/components/Composer";
import { usePincerStore } from "../src/state/store";
import {
	apply,
	conversation,
	liveTurn,
	recordSentFrames,
	requireThread,
	resetStore,
	resume,
} from "./fixtures";
import { click, flush, press, type Rendered, render, typeInto } from "./render";

const store = () => usePincerStore.getState();

let view: Rendered | null = null;

afterEach(() => {
	view?.unmount();
	view = null;
});

interface Mounted {
	textarea: HTMLTextAreaElement;
	sendButton: HTMLButtonElement;
	sent: ClientMessage[];
}

function mount(): Mounted {
	const sent = recordSentFrames();
	view = render(<Composer />);
	const textarea = view.container.querySelector("textarea");
	const sendButton = view.container.querySelector("button");
	if (!textarea || !sendButton) throw new Error("composer did not render");
	return { textarea, sendButton, sent };
}

/** Opens a conversation with no turn in flight — the only state that accepts a prompt. */
function openIdleChat(id = "c1"): void {
	resume(conversation(id));
	usePincerStore.setState({ connected: true });
}

describe("submitting into an open conversation", () => {
	test("sends the trimmed prompt and clears the textarea", () => {
		resetStore();
		openIdleChat();
		const { textarea, sendButton, sent } = mount();

		typeInto(textarea, "  make it blue  ");
		click(sendButton);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ type: "prompt", prompt: "make it blue" });
		expect(textarea.value).toBe("");
	});

	test("shows the prompt optimistically and queues the turn", () => {
		resetStore();
		openIdleChat();
		const { textarea, sendButton } = mount();

		typeInto(textarea, "make it blue");
		click(sendButton);

		expect(requireThread("c1").turnState).toBe("queued");
		expect(requireThread("c1").messages.at(-1)?.blocks).toEqual([
			{ t: "md", text: "make it blue" },
		]);
	});

	test("Cmd+Enter submits from the textarea", () => {
		resetStore();
		openIdleChat();
		const { textarea, sent } = mount();

		typeInto(textarea, "ship it");
		press(textarea, { key: "Enter", metaKey: true });

		expect(sent.map((frame) => frame.type)).toEqual(["prompt"]);
	});

	test("a blank prompt is never sent", () => {
		resetStore();
		openIdleChat();
		const { textarea, sendButton, sent } = mount();

		typeInto(textarea, "   ");
		click(sendButton);

		expect(sent).toEqual([]);
		expect(textarea.value).toBe("   ");
	});

	test("selections travel with the prompt and are cleared afterwards", () => {
		resetStore();
		openIdleChat();
		const node = document.createElement("button");
		document.body.append(node);
		store().toggleSelect(node);
		const { textarea, sendButton, sent } = mount();

		typeInto(textarea, "fix this");
		click(sendButton);

		const frame = sent[0];
		if (frame?.type !== "prompt") throw new Error("expected a prompt frame");
		expect(frame.elements).toHaveLength(1);
		expect(frame.domContext.tag).toBe("button");
		expect(store().selections).toHaveLength(0);
		node.remove();
	});

	test("with no selection the prompt is attributed to the page", () => {
		resetStore();
		openIdleChat();
		const { textarea, sendButton, sent } = mount();

		typeInto(textarea, "anything");
		click(sendButton);

		const frame = sent[0];
		if (frame?.type !== "prompt") throw new Error("expected a prompt frame");
		expect(frame.elements).toEqual([]);
		expect(frame.domContext.tag).toBe("page");
		expect(frame.source).toBeNull();
	});
});

describe("starting a new conversation", () => {
	test("from the list view it asks the daemon for one and holds the text", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		const { textarea, sendButton, sent } = mount();

		typeInto(textarea, "start something");
		click(sendButton);

		expect(sent.map((frame) => frame.type)).toEqual(["new_conversation"]);
		expect(store().pendingPrompt?.prompt).toBe("start something");
		expect(textarea.value).toBe("start something");
	});

	test("the textarea clears only once the conversation opens", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		const { textarea, sendButton } = mount();

		typeInto(textarea, "start something");
		click(sendButton);
		expect(textarea.value).toBe("start something");

		flush(() =>
			apply({
				v: PROTOCOL_VERSION,
				type: "conversation_started",
				conversation: conversation("c1"),
			}),
		);

		expect(textarea.value).toBe("");
	});

	test("the button reads Starting… and is disabled while the creation is pending", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		const { textarea, sendButton } = mount();

		typeInto(textarea, "start something");
		click(sendButton);

		expect(sendButton.textContent).toBe("Starting…");
		expect(sendButton.disabled).toBe(true);
	});
});

describe("cancelling", () => {
	test("the button becomes Stop and cancels the running turn", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		resume(
			conversation("c1", "running"),
			[],
			liveTurn("c1", { turnId: 4, seq: 1 }),
		);
		const { sendButton, sent } = mount();

		expect(sendButton.textContent).toBe("Stop");
		click(sendButton);

		expect(sent).toEqual([
			{ v: PROTOCOL_VERSION, type: "cancel", conversationId: "c1" },
		]);
	});
});

describe("disabled states", () => {
	test("the button is disabled while disconnected", () => {
		resetStore();
		resume(conversation("c1"));
		const { sendButton } = mount();
		expect(sendButton.disabled).toBe(true);
	});

	test("a disconnected composer sends nothing even on Cmd+Enter", () => {
		resetStore();
		resume(conversation("c1"));
		const { textarea, sent } = mount();

		typeInto(textarea, "offline prompt");
		press(textarea, { key: "Enter", metaKey: true });

		expect(sent).toEqual([]);
	});

	test("the placeholder tells you which conversation you are addressing", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		const { textarea } = mount();
		expect(textarea.placeholder).toContain("start a new chat");

		view?.unmount();
		view = null;
		openIdleChat();
		expect(mount().textarea.placeholder).toContain("Describe the change");
	});
});
