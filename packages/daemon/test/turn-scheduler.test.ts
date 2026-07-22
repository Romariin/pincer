import { expect, test } from "bun:test";
import type { ServerMessage } from "@pincer/core";
import { TurnScheduler, type TurnSubmission } from "../src/turnScheduler";

const submission: TurnSubmission = {
	conversationId: "conversation",
	prompt: "prompt",
	source: null,
	domContext: { tag: "button", id: null, classes: [], text: null, ancestry: [] },
	elements: [],
	selection: { harnessId: "omp", model: "model", effort: "" },
};

test("an unexpected executor rejection is persisted before the terminal event is published", async () => {
	const events: string[] = [];
	const messages: ServerMessage[] = [];
	const scheduler = new TurnScheduler({
		publish(message) {
			messages.push(message);
			if (message.type === "turn_error") events.push("published");
		},
		execute: async () => {
			throw new Error("executor exploded");
		},
		persistQueuedCancellation: () => 1,
		persistUnexpectedError: (_submission, snapshot, message) => {
			events.push("persisted");
			expect(snapshot.state).toBe("queued");
			expect(message).toBe("executor exploded");
			return { turnId: 42, seq: 1 };
		},
		onStateChanged() {},
	});

	scheduler.submit(submission);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(events).toEqual(["persisted", "published"]);
	expect(messages.find((message) => message.type === "turn_error")).toMatchObject({
		type: "turn_error",
		turnId: 42,
		message: "executor exploded",
	});
});
