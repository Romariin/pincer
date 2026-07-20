import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@pincer/core";
import { HarnessRunner } from "../src/harnesses/runner";
import type {
	HarnessDefinition,
	HarnessRunOutcome,
	HarnessTurnRequest,
	InstalledHarness,
} from "../src/harnesses/types";
import { FAKE_RUNNER } from "./harness";

setDefaultTimeout(15_000);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const definition: HarnessDefinition = {
	id: "contract-harness",
	display: { label: "Contract", glyph: "C", c1: "#000", c2: "#fff" },
	defaultCommand: [],
	capabilities: {
		modelSelection: true,
		effortSelection: true,
		modelDiscovery: false,
		sessionResume: true,
	},
	defaultModel: "",
	defaultEffort: "",
	efforts: [],
	staticModels: [],
	probeArgs: ["--version"],
	buildTurn(request, command) {
		return {
			argv: [
				...command,
				"run",
				"--model",
				request.selection.model,
				"--effort",
				request.selection.effort,
				...(request.resumeToken
					? [
							"--resume",
							`${request.selection.harnessId}:${request.resumeToken}`,
						]
					: []),
			],
			stdin: JSON.stringify({
				prompt: request.prompt,
				elements: request.elements,
			}),
		};
	},
	decodeRecord(value) {
		if (typeof value !== "object" || value === null) {
			return { kind: "invalid", message: "record must be an object" };
		}
		const record = value as { type?: unknown; events?: unknown };
		if (record.type === "noise") return { kind: "ignore" };
		if (record.type === "invalid")
			return { kind: "invalid", message: "known invalid record" };
		if (record.type === "decoder-throws") throw new Error("decoder exploded");
		if (record.type === "batch" && Array.isArray(record.events)) {
			return { kind: "events", events: record.events as HarnessEvent[] };
		}
		return { kind: "invalid", message: "unsupported test record" };
	},
};

function request(
	overrides: Partial<HarnessTurnRequest> = {},
): HarnessTurnRequest {
	return {
		prompt: "change the title",
		source: null,
		domContext: {
			tag: "h1",
			id: null,
			classes: [],
			text: "Title",
			ancestry: ["h1"],
		},
		elements: [],
		projectRoot: "/tmp",
		pincerDataDir: "/tmp/pincer-data",
		conversationId: "conversation-1",
		selection: {
			harnessId: definition.id,
			model: "vendor/model:opaque@2026",
			effort: "Vendor-Effort/7",
		},
		resumeToken: "token/with opaque:bytes",
		...overrides,
	};
}

async function runPlan(
	plan: Record<string, unknown>,
	onEvent: (event: HarnessEvent) => void = () => {},
): Promise<{ outcome: HarnessRunOutcome; root: string; recordPath: string }> {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-contract-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	writeFileSync(planPath, JSON.stringify(plan));
	const installed: InstalledHarness = {
		definition,
		command: ["bun", FAKE_RUNNER, planPath, recordPath],
		detected: true,
		models: [],
	};
	const running = new HarnessRunner().start(
		installed,
		request({ projectRoot: root }),
		onEvent,
	);
	return { outcome: await running.outcome, root, recordPath };
}

test("runner preserves invocation bytes, expands multi-event records, and diagnoses only invalid records", async () => {
	const observed: HarnessEvent[] = [];
	const { outcome, root, recordPath } = await runPlan(
		{
			records: [
				{ type: "noise" },
				{ type: "invalid" },
				{
					type: "batch",
					events: [
						{ kind: "status", text: "ready" },
						{ kind: "session", token: "session-42" },
						{ kind: "text", text: "changed" },
						{ kind: "result", success: true, summary: "complete" },
					],
				},
			],
		},
		(event) => observed.push(event),
	);

	const recorded = JSON.parse(readFileSync(recordPath, "utf8")) as {
		argv: string[];
		stdin: string;
	};
	expect(recorded.argv).toEqual([
		join(root, "plan.json"),
		recordPath,
		"run",
		"--model",
		"vendor/model:opaque@2026",
		"--effort",
		"Vendor-Effort/7",
		"--resume",
		"contract-harness:token/with opaque:bytes",
	]);
	expect(recorded.stdin).toBe(
		JSON.stringify({ prompt: "change the title", elements: [] }),
	);
	expect(observed).toEqual([
		{ kind: "status", text: "ready" },
		{ kind: "session", token: "session-42" },
		{ kind: "text", text: "changed" },
		{ kind: "result", success: true, summary: "complete" },
	]);
	expect(outcome).toEqual({
		status: "succeeded",
		sessionToken: "session-42",
		summary: "complete",
		diagnostics: ["known invalid record"],
		stderr: "",
	});
});

const completionCases: [
	name: string,
	records: Record<string, unknown>[],
	exitCode: number,
	summary: string,
][] = [
	[
		"a result failure on exit zero",
		[
			{
				type: "batch",
				events: [{ kind: "result", success: false, summary: "denied" }],
			},
		],
		0,
		"denied",
	],
	[
		"an exit-zero stream missing its result",
		[{ type: "batch", events: [{ kind: "text", text: "partial" }] }],
		0,
		"Harness exited without a terminal result.",
	],
	[
		"duplicate results",
		[
			{
				type: "batch",
				events: [
					{ kind: "result", success: true, summary: "first" },
					{ kind: "result", success: true, summary: "second" },
				],
			},
		],
		0,
		"Harness emitted 2 terminal results.",
	],
	[
		"a successful result followed by nonzero exit",
		[
			{
				type: "batch",
				events: [{ kind: "result", success: true, summary: "done" }],
			},
		],
		7,
		"Harness exited with code 7.",
	],
];

test.each(completionCases)(
	"runner rejects %s",
	async (_name, records, exitCode, summary) => {
		const { outcome } = await runPlan({ records, exitCode });
		expect(outcome.status).toBe("failed");
		expect(outcome.summary).toBe(summary);
	},
);

test("runner bounds captured stderr without changing the process completion rule", async () => {
	const stderr = "E".repeat(20_000);
	const { outcome } = await runPlan({
		records: [
			{
				type: "batch",
				events: [{ kind: "result", success: true, summary: "done" }],
			},
		],
		stderr,
	});
	expect(outcome.status).toBe("succeeded");
	expect(outcome.stderr).toHaveLength(16_384);
	expect(outcome.stderr).toBe("E".repeat(16_384));
});

test("runner cancellation terminates the Harness process group, including descendants", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-cancel-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	const releaseFile = join(root, "release");
	const childPidFile = join(root, "child.pid");
	writeFileSync(
		planPath,
		JSON.stringify({
			waitFor: releaseFile,
			childPidFile,
			records: [{ type: "batch", events: [{ kind: "status", text: "ready" }] }],
		}),
	);
	const installed: InstalledHarness = {
		definition,
		command: ["bun", FAKE_RUNNER, planPath, recordPath],
		detected: true,
		models: [],
	};
	let signalReady = (): void => {};
	const ready = new Promise<void>((resolve) => {
		signalReady = resolve;
	});
	const running = new HarnessRunner().start(
		installed,
		request({ projectRoot: root }),
		(event) => {
			if (event.kind === "status" && event.text === "ready") signalReady();
		},
	);
	await ready;
	const childPid = Number(readFileSync(childPidFile, "utf8"));

	await running.cancel();
	expect(await running.outcome).toMatchObject({
		status: "cancelled",
		summary: "Turn cancelled.",
	});
	expect(() => process.kill(childPid, 0)).toThrow();
});
