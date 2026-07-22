import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	PROTOCOL_VERSION,
	type ClientMessage,
	type ConversationConfig,
} from "@pincer/core";
import { createHarness, type Harness } from "./harness";

const V = PROTOCOL_VERSION;
let harness: Harness | undefined;
setDefaultTimeout(30_000);

afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

async function startConversation(
	current: Harness,
	config: ConversationConfig = {},
): Promise<string> {
	current.send({ v: V, type: "new_conversation", ...config });
	return (await current.next("conversation_started")).conversation.id;
}

function submitTurn(
	current: Harness,
	conversationId: string,
	prompt: string,
): void {
	current.send({
		v: V,
		type: "prompt",
		conversationId,
		prompt,
		source: current.source,
		domContext: current.domContext,
	});
}

async function completeTurn(
	current: Harness,
	conversationId: string,
	prompt: string,
): Promise<void> {
	submitTurn(current, conversationId, prompt);
	await current.nextWhere(
		(message) =>
			message.type === "turn_started" &&
			message.conversationId === conversationId,
	);
	const complete = await current.nextWhere(
		(message) =>
			message.type === "turn_complete" &&
			message.conversationId === conversationId,
	);
	expect(complete).toMatchObject({ type: "turn_complete", success: true });
}

function rows(
	current: Harness,
	sql: string,
	...params: (string | number)[]
): Record<string, unknown>[] {
	const db = new Database(current.historyDbPath, { readonly: true });
	try {
		return db.query(sql).all(...params) as Record<string, unknown>[];
	} finally {
		db.close();
	}
}

test("malformed WebSocket messages are rejected before dispatch", async () => {
	harness = await createHarness();
	await harness.next("welcome");
	const malformed: unknown[] = [
		{ v: V + 1, type: "new_conversation" },
		{ v: V, type: "new_conversation", harnessId: 12 },
		{ v: V, type: "resume_conversation", conversationId: null },
		{
			v: V,
			type: "prompt",
			conversationId: "never-created",
			prompt: "run despite malformed context",
			source: { path: "src/App.tsx", line: "2", column: 0 },
			domContext: harness.domContext,
		},
		{
			v: V,
			type: "prompt",
			conversationId: "never-created",
			prompt: "x".repeat(1_100_000),
			source: null,
			domContext: harness.domContext,
		},
	];

	for (const message of malformed) {
		harness.send(message as ClientMessage);
		expect(await harness.next("error")).toMatchObject({ code: "bad_message" });
	}
	harness.send({ v: V, type: "list_conversations" });
	expect((await harness.next("conversations")).items).toEqual([]);
	expect(harness.invocations()).toEqual([]);
});

test("an explicit unknown or unavailable Harness blocks instead of falling back to detected OMP", async () => {
	harness = await createHarness({ selectedHarnessId: "claude-code" });
	const welcome = await harness.next("welcome");
	expect(welcome.defaultHarnessId).toBeNull();
	expect(welcome.harnesses.find((item) => item.id === "omp")?.detected).toBe(
		true,
	);
	expect(
		welcome.harnesses.find((item) => item.id === "claude-code")?.detected,
	).toBe(false);

	harness.send({ v: V, type: "new_conversation" });
	expect(await harness.next("blocked")).toMatchObject({
		reason: "harness_unavailable",
	});

	harness.send({ v: V, type: "new_conversation", harnessId: "not-a-harness" });
	expect(await harness.next("blocked")).toMatchObject({
		reason: "unknown_harness",
	});
	expect(harness.invocations()).toEqual([]);
});

test("one daemon slot runs FIFO across conversations and snapshots each queued Harness selection", async () => {
	harness = await createHarness({
		plan: {
			executions: [
				{
					session: "first-session",
					text: "first-ready",
					waitFor: "release-first",
					edits: [{ path: "src/App.tsx", append: "\n// FIRST_INTERVAL\n" }],
				},
				{
					session: "second-session",
					text: "second-ready",
					waitFor: "release-second",
					edits: [{ path: "src/App.tsx", append: "\n// SECOND_INTERVAL\n" }],
				},
			],
		},
	});
	await harness.next("welcome");
	const firstId = await startConversation(harness, {
		harnessId: "omp",
		model: "model-first",
		effort: "effort-first",
	});
	const secondId = await startConversation(harness, {
		harnessId: "omp",
		model: "model-second",
		effort: "effort-second",
	});

	submitTurn(harness, firstId, "first prompt");
	const firstStarted = await harness.nextWhere(
		(message) =>
			message.type === "turn_started" && message.conversationId === firstId,
	);
	expect(firstStarted).toMatchObject({
		type: "turn_started",
		liveTurn: {
			state: "running",
			queuePosition: null,
			selection: { harnessId: "omp" },
		},
	});
	await harness.nextWhere(
		(message) =>
			message.type === "harness_output" &&
			message.conversationId === firstId &&
			message.event.kind === "text" &&
			message.event.text === "first-ready",
	);

	submitTurn(harness, secondId, "second prompt");
	const queued = await harness.nextWhere(
		(message) =>
			message.type === "turn_queued" && message.conversationId === secondId,
	);
	expect(queued).toMatchObject({
		type: "turn_queued",
		liveTurn: {
			turnId: null,
			seq: null,
			state: "queued",
			queuePosition: 1,
			prompt: "second prompt",
			selection: {
				harnessId: "omp",
				model: "model-second",
				effort: "effort-second",
			},
		},
	});

	submitTurn(harness, secondId, "must not replace the queued prompt");
	expect(await harness.next("blocked")).toMatchObject({
		reason: "outstanding_turn",
		conversationId: secondId,
	});
	harness.send({
		v: V,
		type: "set_config",
		conversationId: secondId,
		model: "must-not-replace-snapshot",
	});
	expect(await harness.next("blocked")).toMatchObject({
		reason: "outstanding_turn",
		conversationId: secondId,
	});

	harness.send({ v: V, type: "list_conversations" });
	const liveList = await harness.nextWhere(
		(message) =>
			message.type === "conversations" &&
			message.items.some(
				(item) => item.id === firstId && item.turnState === "running",
			) &&
			message.items.some(
				(item) =>
					item.id === secondId &&
					item.turnState === "queued" &&
					item.queuePosition === 1,
			),
	);
	expect(liveList.type).toBe("conversations");

	harness.release("release-first");
	const firstAfterRelease = await harness.nextWhere(
		(message) =>
			(message.type === "turn_complete" &&
				message.conversationId === firstId) ||
			(message.type === "turn_started" && message.conversationId === secondId),
	);
	expect(firstAfterRelease).toMatchObject({
		type: "turn_complete",
		conversationId: firstId,
	});
	const secondStarted = await harness.nextWhere(
		(message) =>
			message.type === "turn_started" && message.conversationId === secondId,
	);
	expect(secondStarted).toMatchObject({
		type: "turn_started",
		liveTurn: {
			prompt: "second prompt",
			selection: {
				harnessId: "omp",
				model: "model-second",
				effort: "effort-second",
			},
		},
	});
	harness.release("release-second");
	await harness.nextWhere(
		(message) =>
			message.type === "turn_complete" && message.conversationId === secondId,
	);

	const firstRow = rows(
		harness,
		"SELECT status, blocks FROM turns WHERE conversation_id = ?",
		firstId,
	)[0];
	const secondRow = rows(
		harness,
		"SELECT status, blocks FROM turns WHERE conversation_id = ?",
		secondId,
	)[0];
	expect(firstRow?.status).toBe("complete");
	expect(secondRow?.status).toBe("complete");
	expect(firstRow?.blocks).toContain("FIRST_INTERVAL");
	expect(firstRow?.blocks).not.toContain("SECOND_INTERVAL");
	expect(secondRow?.blocks).toContain("SECOND_INTERVAL");
	expect(secondRow?.blocks).not.toContain("FIRST_INTERVAL");
});

test("a running turn survives WebSocket disconnect and is replayed live after reconnect", async () => {
	harness = await createHarness({
		plan: {
			executions: [
				{
					session: "survivor-session",
					text: "still-running",
					waitFor: "release-survivor",
				},
			],
		},
	});
	await harness.next("welcome");
	const conversationId = await startConversation(harness);
	submitTurn(harness, conversationId, "survive navigation");
	await harness.nextWhere(
		(message) =>
			message.type === "harness_output" &&
			message.conversationId === conversationId &&
			message.event.kind === "text",
	);

	await harness.disconnect();
	await harness.reconnect();
	await harness.next("welcome");
	harness.send({ v: V, type: "resume_conversation", conversationId });
	const resumed = await harness.next("conversation_resumed");
	expect(resumed.liveTurn).toMatchObject({
		conversationId,
		state: "running",
		prompt: "survive navigation",
		blocks: [{ t: "md", text: "still-running" }],
	});

	harness.release("release-survivor");
	expect(await harness.next("turn_complete")).toMatchObject({
		conversationId,
		success: true,
	});
});

test("queued and running cancellation persist distinct cancelled turns", async () => {
	harness = await createHarness({
		plan: {
			executions: [
				{
					session: "active-session",
					text: "active-ready",
					waitFor: "never-release-active",
				},
				{
					session: "queued-session",
					text: "queued-must-not-start",
					waitFor: "never-release-queued",
				},
			],
		},
	});
	await harness.next("welcome");
	const activeId = await startConversation(harness);
	const queuedId = await startConversation(harness);
	submitTurn(harness, activeId, "active prompt");
	await harness.nextWhere(
		(message) =>
			message.type === "harness_output" &&
			message.conversationId === activeId &&
			message.event.kind === "text",
	);

	submitTurn(harness, queuedId, "queued prompt");
	await harness.nextWhere(
		(message) =>
			message.type === "turn_queued" && message.conversationId === queuedId,
	);
	harness.send({ v: V, type: "cancel", conversationId: queuedId });
	const queuedCancelled = await harness.nextWhere(
		(message) =>
			message.type === "turn_cancelled" && message.conversationId === queuedId,
	);
	expect(queuedCancelled).toMatchObject({ type: "turn_cancelled" });
	if (queuedCancelled.type !== "turn_cancelled")
		throw new Error("expected queued cancellation");
	expect(queuedCancelled.turnId).not.toBeNull();

	harness.send({ v: V, type: "cancel", conversationId: activeId });
	const activeCancelled = await harness.nextWhere(
		(message) =>
			message.type === "turn_cancelled" && message.conversationId === activeId,
	);
	expect(activeCancelled).toMatchObject({ type: "turn_cancelled" });

	expect(
		rows(
			harness,
			"SELECT conversation_id, status FROM turns WHERE conversation_id IN (?, ?) ORDER BY conversation_id",
			activeId,
			queuedId,
		),
	).toEqual(
		[
			{ conversation_id: activeId, status: "cancelled" },
			{ conversation_id: queuedId, status: "cancelled" },
		].sort((left, right) =>
			left.conversation_id.localeCompare(right.conversation_id),
		),
	);
});

test("delete waits for process-tree cancellation before removing conversation rows", async () => {
	harness = await createHarness({
		plan: {
			executions: [
				{
					text: "delete-ready",
					waitFor: "never-release-delete",
					spawnChildPidFile: "delete-child.pid",
				},
			],
		},
	});
	await harness.next("welcome");
	const conversationId = await startConversation(harness);
	submitTurn(harness, conversationId, "delete while running");
	await harness.nextWhere(
		(message) =>
			message.type === "harness_output" &&
			message.conversationId === conversationId &&
			message.event.kind === "text",
	);
	const childPid = Number(
		readFileSync(join(harness.fakeRoot, "delete-child.pid"), "utf8"),
	);

	harness.send({ v: V, type: "delete_conversation", conversationId });
	expect(await harness.next("deleted")).toMatchObject({ conversationId });
	expect(() => process.kill(childPid, 0)).toThrow();
	expect(
		rows(harness, "SELECT id FROM conversations WHERE id = ?", conversationId),
	).toEqual([]);
	expect(
		rows(
			harness,
			"SELECT id FROM turns WHERE conversation_id = ?",
			conversationId,
		),
	).toEqual([]);
});

test("daemon shutdown cancels both the active process and every queued turn before closing SQLite", async () => {
	harness = await createHarness({
		plan: {
			executions: [
				{ text: "shutdown-active", waitFor: "never-release-shutdown" },
				{ text: "shutdown-queued", waitFor: "never-release-queued" },
			],
		},
	});
	await harness.next("welcome");
	const activeId = await startConversation(harness);
	const queuedId = await startConversation(harness);
	submitTurn(harness, activeId, "active during shutdown");
	await harness.nextWhere(
		(message) =>
			message.type === "harness_output" &&
			message.conversationId === activeId &&
			message.event.kind === "text",
	);
	submitTurn(harness, queuedId, "queued during shutdown");
	await harness.nextWhere(
		(message) =>
			message.type === "turn_queued" && message.conversationId === queuedId,
	);

	await harness.restart();
	expect(
		rows(
			harness,
			"SELECT conversation_id, status FROM turns WHERE conversation_id IN (?, ?) ORDER BY conversation_id",
			activeId,
			queuedId,
		),
	).toEqual(
		[
			{ conversation_id: activeId, status: "cancelled" },
			{ conversation_id: queuedId, status: "cancelled" },
		].sort((left, right) =>
			left.conversation_id.localeCompare(right.conversation_id),
		),
	);
});

test("resume tokens are reused only across consecutive turns owned by the same Harness", async () => {
	harness = await createHarness({
		enableFakeClaude: true,
		plan: {
			executions: [
				{ session: "omp-token", text: "omp first" },
				{ session: "claude-token", text: "claude first" },
				{ session: "claude-token-2", text: "claude second" },
				{ session: "omp-token-2", text: "omp after claude" },
			],
		},
	});
	await harness.next("welcome");
	const conversationId = await startConversation(harness, { harnessId: "omp" });
	await completeTurn(harness, conversationId, "omp first");

	harness.send({
		v: V,
		type: "set_config",
		conversationId,
		harnessId: "claude-code",
	});
	await harness.next("config_updated");
	await completeTurn(harness, conversationId, "claude first");
	await completeTurn(harness, conversationId, "claude second");

	harness.send({ v: V, type: "set_config", conversationId, harnessId: "omp" });
	await harness.next("config_updated");
	await completeTurn(harness, conversationId, "omp after claude");

	const invocations = harness.invocations();
	expect(invocations.map((invocation) => invocation.kind)).toEqual([
		"omp",
		"claude",
		"claude",
		"omp",
	]);
	expect(invocations[0]?.argv).not.toContain("-r");
	expect(invocations[1]?.argv).not.toContain("--resume");
	const claudeResume = invocations[2]?.argv.indexOf("--resume") ?? -1;
	expect(invocations[2]?.argv[claudeResume + 1]).toBe("claude-token");
	expect(invocations[3]?.argv).not.toContain("-r");

	expect(
		rows(
			harness,
			"SELECT harness_id, resume_token, status FROM turns WHERE conversation_id = ? ORDER BY seq",
			conversationId,
		),
	).toEqual([
		{ harness_id: "omp", resume_token: "omp-token", status: "complete" },
		{
			harness_id: "claude-code",
			resume_token: "claude-token",
			status: "complete",
		},
		{
			harness_id: "claude-code",
			resume_token: "claude-token-2",
			status: "complete",
		},
		{ harness_id: "omp", resume_token: "omp-token-2", status: "complete" },
	]);
});

test("live Harness text is bounded and the truncated snapshot is what resume and SQLite expose", async () => {
	harness = await createHarness({
		plan: { executions: [{ session: "large-output", textChars: 300_000 }] },
	});
	await harness.next("welcome");
	const conversationId = await startConversation(harness);
	submitTurn(harness, conversationId, "produce large output");
	const output = await harness.nextWhere(
		(message) =>
			message.type === "harness_output" &&
			message.conversationId === conversationId &&
			message.event.kind === "text",
	);
	if (output.type !== "harness_output" || output.event.kind !== "text") {
		throw new Error("expected Harness text output");
	}
	expect(output.event.text.length).toBeLessThan(257_000);
	expect(output.event.text).toEndWith("[Live output truncated]");
	await harness.next("turn_complete");

	harness.send({ v: V, type: "resume_conversation", conversationId });
	const resumed = await harness.next("conversation_resumed");
	expect(resumed.liveTurn).toBeNull();
	expect(resumed.turns[0]?.output).toBe(output.event.text);
	expect(
		rows(
			harness,
			"SELECT output FROM turns WHERE conversation_id = ?",
			conversationId,
		),
	).toEqual([{ output: output.event.text }]);
});
