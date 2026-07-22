import { expect, test } from "bun:test";
import type { ServerMessage } from "@pincer/core";
import { TurnScheduler, type TurnSubmission } from "../src/turnScheduler";

const submission: TurnSubmission = {
	conversationId: "conversation",
	prompt: "prompt",
	source: null,
	domContext: {
		tag: "button",
		id: null,
		classes: [],
		text: null,
		ancestry: [],
	},
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
	expect(messages.map((message) => message.type)).toEqual([
		"turn_queued",
		"turn_started",
		"turn_error",
	]);
	expect(
		messages.find((message) => message.type === "turn_started"),
	).toMatchObject({
		type: "turn_started",
		turnId: 42,
		seq: 1,
	});
	expect(
		messages.find((message) => message.type === "turn_error"),
	).toMatchObject({
		type: "turn_error",
		turnId: 42,
		message: "executor exploded",
	});
});

test("queued positions include an active turn that has not started yet", async () => {
	let release = (): void => {};
	const execution = new Promise<void>((resolve) => {
		release = resolve;
	});
	const scheduler = new TurnScheduler({
		publish() {},
		execute: async () => execution,
		persistQueuedCancellation: () => 1,
		persistUnexpectedError: () => ({ turnId: 1, seq: 1 }),
		onStateChanged() {},
	});

	scheduler.submit(submission);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const second = scheduler.submit({
		...submission,
		conversationId: "conversation-2",
	});

	expect(scheduler.stateFor("conversation")).toEqual({
		state: "queued",
		queuePosition: 1,
	});
	expect(second?.queuePosition).toBe(2);
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
});

test("the active pre-start snapshot remains a valid queued state", async () => {
	let release = (): void => {};
	const execution = new Promise<void>((resolve) => {
		release = resolve;
	});
	const snapshots: { state: string; queuePosition: number | null }[] = [];
	let scheduler: TurnScheduler;
	scheduler = new TurnScheduler({
		publish() {},
		execute: async () => execution,
		persistQueuedCancellation: () => 1,
		persistUnexpectedError: () => ({ turnId: 1, seq: 1 }),
		onStateChanged: () => snapshots.push(scheduler.stateFor("conversation")),
	});

	scheduler.submit(submission);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(snapshots.at(-1)).toEqual({ state: "queued", queuePosition: 1 });
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
});
