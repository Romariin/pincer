import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@pincer/core";
import { createHarness, type Harness } from "./harness";

const V = PROTOCOL_VERSION;
let harness: Harness | undefined;
setDefaultTimeout(30_000);

afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

async function startConversation(current: Harness): Promise<string> {
	current.send({ v: V, type: "new_conversation", harnessId: "omp" });
	return (await current.next("conversation_started")).conversation.id;
}

async function runTurn(
	current: Harness,
	conversationId: string,
	prompt: string,
): Promise<void> {
	current.send({
		v: V,
		type: "prompt",
		conversationId,
		prompt,
		source: current.source,
		domContext: current.domContext,
	});
	await current.next("turn_started");
	expect(await current.next("turn_complete")).toMatchObject({
		success: true,
		checkpoint: null,
	});
}

test("real OMP definition edits the project and persists its Harness-qualified session token", async () => {
	harness = await createHarness({
		plan: {
			executions: [
				{
					session: "omp-session-contract",
					text: "Applying the requested edit",
					edits: [{ path: "src/App.tsx", append: "\n// OMP_EDIT\n" }],
				},
			],
		},
	});
	await harness.next("welcome");
	const conversationId = await startConversation(harness);
	await runTurn(harness, conversationId, harness.userPrompt);

	expect(harness.readTarget()).toContain("OMP_EDIT");
	const invocation = harness.invocations()[0];
	expect(invocation?.kind).toBe("omp");
	const sessionDir = invocation?.argv.indexOf("--session-dir") ?? -1;
	expect(invocation?.argv[sessionDir + 1]).toBe(
		join(harness.pincerDataDir, "omp-sessions"),
	);
	expect(invocation?.argv.at(-1)).toContain(harness.userPrompt);
	expect(invocation?.argv.at(-1)).toContain("src/App.tsx");

	const db = new Database(harness.historyDbPath, { readonly: true });
	try {
		expect(
			db
				.query(
					"SELECT harness_id, resume_token, status FROM turns WHERE conversation_id = ?",
				)
				.get(conversationId),
		).toEqual({
			harness_id: "omp",
			resume_token: "omp-session-contract",
			status: "complete",
		});
	} finally {
		db.close();
	}
});

test("a consecutive OMP turn resumes with the token issued by the prior OMP turn", async () => {
	harness = await createHarness({
		plan: {
			executions: [
				{ session: "omp-session-first", text: "first" },
				{ session: "omp-session-second", text: "second" },
			],
		},
	});
	await harness.next("welcome");
	const conversationId = await startConversation(harness);
	await runTurn(harness, conversationId, "first change");
	await runTurn(harness, conversationId, "second change");

	const second = harness.invocations()[1];
	const resumeFlag = second?.argv.indexOf("-r") ?? -1;
	expect(second?.argv[resumeFlag + 1]).toBe("omp-session-first");
});
