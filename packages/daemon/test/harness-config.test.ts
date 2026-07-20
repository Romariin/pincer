import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { PROTOCOL_VERSION } from "@pincer/core";
import { createHarness, type Harness } from "./harness";

const V = PROTOCOL_VERSION;
let harness: Harness | undefined;
setDefaultTimeout(30_000);

afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

test("welcome exposes protocol-v4 catalog-only Harness descriptors and only CLI-reported OMP models", async () => {
	harness = await createHarness({ selectedHarnessId: "omp" });
	const welcome = await harness.next("welcome");
	const omp = welcome.harnesses.find((candidate) => candidate.id === "omp");

	expect(welcome.v).toBe(V);
	expect(welcome.defaultHarnessId).toBe("omp");
	expect(Object.keys(omp ?? {}).sort()).toEqual([
		"c1",
		"c2",
		"detected",
		"glyph",
		"icon",
		"id",
		"label",
		"models",
	]);
	expect(omp).toMatchObject({ id: "omp", detected: true });
	expect(omp?.models).toEqual([
		{
			id: "anthropic/claude-opus-4-8",
			label: "Claude Opus 4.8",
			efforts: ["low", "medium", "high", "max"],
		},
		{
			id: "anthropic/claude-sonnet-5",
			label: "Claude Sonnet 5",
			efforts: [],
		},
	]);
	expect(
		welcome.harnesses.flatMap((candidate) =>
			candidate.models.filter((model) => model.id === ""),
		),
	).toEqual([]);
});

test("welcome exposes Claude's control-initialized picker models and efforts", async () => {
	harness = await createHarness({
		enableFakeClaude: true,
		selectedHarnessId: "claude-code",
	});
	const welcome = await harness.next("welcome");
	const claude = welcome.harnesses.find(
		(candidate) => candidate.id === "claude-code",
	);

	expect(Object.keys(claude ?? {}).sort()).toEqual([
		"c1",
		"c2",
		"detected",
		"glyph",
		"icon",
		"id",
		"label",
		"models",
	]);
	expect(claude?.models).toEqual([
		{
			id: "opus[1m]",
			label: "Opus",
			efforts: ["low", "medium", "high", "xhigh", "max"],
		},
		{
			id: "claude-fable-5[1m]",
			label: "Fable",
			efforts: ["low", "medium", "high", "xhigh", "max"],
		},
		{
			id: "sonnet",
			label: "Sonnet",
			efforts: ["low", "medium", "high", "xhigh", "max"],
		},
		{
			id: "haiku",
			label: "Haiku",
			efforts: [],
		},
	]);
	expect(harness.invocations()).toEqual([]);
});

const unavailableHarnessCases: {
	name: string;
	harnessId: "codex" | "omp";
	options: Parameters<typeof createHarness>[0];
}[] = [
	{
		name: "its CLI probe fails",
		harnessId: "codex",
		options: { selectedHarnessId: "codex" },
	},
	{
		name: "its CLI catalog command fails",
		harnessId: "omp",
		options: {
			selectedHarnessId: "omp",
			plan: { catalogExitCode: 9 },
		},
	},
];

test.each(unavailableHarnessCases)(
	"welcome exposes no models and no default when the selected Harness $name",
	async ({ harnessId, options }) => {
		harness = await createHarness(options);
		const welcome = await harness.next("welcome");
		const unavailable = welcome.harnesses.find(
			(candidate) => candidate.id === harnessId,
		);

		expect(welcome.defaultHarnessId).toBeNull();
		expect(unavailable).toMatchObject({
			id: harnessId,
			detected: false,
			models: [],
		});
	},
);

test("conversation selection preserves opaque model and effort values into the real OMP invocation", async () => {
	harness = await createHarness();
	await harness.next("welcome");
	harness.send({
		v: V,
		type: "new_conversation",
		harnessId: "omp",
		model: "vendor/model:opaque@2026",
		effort: "Vendor-Effort/7",
	});
	const started = await harness.next("conversation_started");
	expect(started.conversation).toMatchObject({
		harnessId: "omp",
		model: "vendor/model:opaque@2026",
		effort: "Vendor-Effort/7",
		turnState: "idle",
		queuePosition: null,
	});

	harness.send({
		v: V,
		type: "prompt",
		conversationId: started.conversation.id,
		prompt: harness.userPrompt,
		source: harness.source,
		domContext: harness.domContext,
	});
	const queued = await harness.next("turn_queued");
	expect(queued.liveTurn.selection).toEqual({
		harnessId: "omp",
		model: "vendor/model:opaque@2026",
		effort: "Vendor-Effort/7",
	});
	await harness.next("turn_complete");

	const invocation = harness.invocations()[0];
	expect(
		invocation?.argv.slice(invocation.argv.indexOf("--model"), -1),
	).toEqual([
		"--model",
		"vendor/model:opaque@2026",
		"--thinking",
		"Vendor-Effort/7",
	]);
});

test("set_config changes subsequent turn selection and deleting the conversation removes its history", async () => {
	harness = await createHarness();
	await harness.next("welcome");
	harness.send({
		v: V,
		type: "new_conversation",
		harnessId: "omp",
		model: "model-a",
		effort: "effort-a",
	});
	const started = await harness.next("conversation_started");

	harness.send({
		v: V,
		type: "set_config",
		conversationId: started.conversation.id,
		model: "model-b",
		effort: "effort-b",
	});
	const updated = await harness.next("config_updated");
	expect(updated.conversation).toMatchObject({
		model: "model-b",
		effort: "effort-b",
	});

	harness.send({
		v: V,
		type: "delete_conversation",
		conversationId: started.conversation.id,
	});
	expect(await harness.next("deleted")).toMatchObject({
		conversationId: started.conversation.id,
	});
	harness.send({ v: V, type: "list_conversations" });
	const conversations = await harness.next("conversations");
	expect(
		conversations.items.some(
			(conversation) => conversation.id === started.conversation.id,
		),
	).toBe(false);
});
