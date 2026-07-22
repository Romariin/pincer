import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@pincer/core";
import { resolveHarnesses } from "../src/harnesses/registry";
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

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (process.platform === "win32") return true;
	const result = Bun.spawnSync(["ps", "-o", "state=", "-p", String(pid)]);
	return (
		result.exitCode === 0 && !result.stdout.toString().trim().startsWith("Z")
	);
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const definition: HarnessDefinition = {
	id: "contract-harness",
	display: { label: "Contract", glyph: "C", c1: "#000", c2: "#fff" },
	capabilities: { model: true, effort: true, resume: true },
	defaultCommand: [],
	probeArgs: ["--version"],
	catalog: {
		models: {
			build(command) {
				return { argv: [...command, "catalog"] };
			},
			decode(output) {
				const parsed = JSON.parse(output) as {
					models?: { id?: unknown; label?: unknown; efforts?: unknown }[];
				};
				if (!Array.isArray(parsed.models)) return [];
				return parsed.models.flatMap((model) =>
					typeof model.id === "string" &&
					typeof model.label === "string" &&
					Array.isArray(model.efforts) &&
					model.efforts.every((effort) => typeof effort === "string")
						? [
								{
									id: model.id,
									label: model.label,
									efforts: model.efforts as string[],
								},
							]
						: [],
				);
			},
		},
	},
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
		catalog: { status: "ready", diagnostics: [] },
		models: [],
	};
	const running = new HarnessRunner().start(
		installed,
		request({ projectRoot: root }),
		onEvent,
	);
	return { outcome: await running.outcome, root, recordPath };
}

const installationCases: [
	name: string,
	catalogOutput: string | null,
	expectedDetected: boolean,
	expectedCatalogStatus: "ready" | "failed",
	expectedModels: { id: string; label: string; efforts: string[] }[],
][] = [
	["an unavailable CLI", null, false, "failed", []],
	["a malformed catalog response", "not-json", true, "failed", []],
	["an empty catalog", JSON.stringify({ models: [] }), true, "ready", []],
	[
		"a non-empty CLI catalog",
		JSON.stringify({
			models: [
				{
					id: "cli/model-2026",
					label: "CLI Model 2026",
					efforts: ["brief", "deep"],
				},
			],
		}),
		true,
		"ready",
		[
			{
				id: "cli/model-2026",
				label: "CLI Model 2026",
				efforts: ["brief", "deep"],
			},
		],
	],
];

test.each(installationCases)(
	"installer separates CLI availability from the advisory catalog for %s",
	async (_name, catalogOutput, expectedDetected, expectedCatalogStatus, expectedModels) => {
		let command: string[];
		if (catalogOutput === null) {
			command = [`pincer-test-missing-runner-${crypto.randomUUID()}`];
		} else {
			const root = mkdtempSync(join(tmpdir(), "pincer-runner-install-"));
			roots.push(root);
			const planPath = join(root, "plan.json");
			const recordPath = join(root, "record.json");
			writeFileSync(planPath, JSON.stringify({ rawLines: [catalogOutput] }));
			command = ["bun", FAKE_RUNNER, planPath, recordPath];
		}

		const installed = await HarnessRunner.install(definition, command, {
			projectRoot: "/tmp",
			env: process.env,
		});

		expect(installed.detected).toBe(expectedDetected);
		expect(installed.catalog.status).toBe(expectedCatalogStatus);
		expect(installed.catalog.diagnostics.length).toBe(
			expectedCatalogStatus === "failed" ? 1 : 0,
		);
		expect(installed.models).toEqual(expectedModels);
	},
);

test("installer marks an omitted advisory catalog as unsupported without hiding the CLI", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-no-catalog-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	writeFileSync(planPath, JSON.stringify({}));
	const withoutCatalog: HarnessDefinition = {
		...definition,
		catalog: undefined,
	};

	const installed = await HarnessRunner.install(
		withoutCatalog,
		["bun", FAKE_RUNNER, planPath, recordPath],
		{ projectRoot: root, env: process.env },
	);

	expect(installed).toMatchObject({
		detected: true,
		catalog: { status: "unsupported", diagnostics: [] },
		models: [],
	});
});

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

test("runner retains the bounded stderr tail without changing the process completion rule", async () => {
	const stderr = `${"prefix".repeat(4_000)}${"T".repeat(16_384)}`;
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
	expect(outcome.stderr).toBe("T".repeat(16_384));
});

test("runner discards an oversized NDJSON line and continues at the next record", async () => {
	const terminal = JSON.stringify({
		type: "batch",
		events: [{ kind: "result", success: true, summary: "done" }],
	});
	const { outcome } = await runPlan({
		rawLines: ["X".repeat(1_048_577), terminal],
	});

	expect(outcome.status).toBe("succeeded");
	expect(outcome.diagnostics).toContain(
		"Harness NDJSON record exceeded 1048576 bytes",
	);
});

test("a throwing event consumer stops the Harness instead of deadlocking", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-consumer-error-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	writeFileSync(
		planPath,
		JSON.stringify({
			records: [{ type: "batch", events: [{ kind: "status", text: "ready" }] }],
			waitFor: join(root, "never"),
		}),
	);
	const installed: InstalledHarness = {
		definition,
		command: ["bun", FAKE_RUNNER, planPath, recordPath],
		detected: true,
		catalog: { status: "ready", diagnostics: [] },
		models: [],
	};
	const running = new HarnessRunner().start(
		installed,
		request({ projectRoot: root }),
		() => {
			throw new Error("consumer exploded");
		},
	);
	const outcome = await Promise.race([
		running.outcome,
		Bun.sleep(2_500).then(() => null),
	]);
	if (!outcome) await running.cancel();

	expect(outcome).toMatchObject({
		status: "failed",
		summary: expect.stringContaining("consumer exploded"),
	});
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
		catalog: { status: "ready", diagnostics: [] },
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

test("a successful Harness run stops descendants before resolving", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-leader-exited-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	const childPidFile = join(root, "child.pid");
	writeFileSync(
		planPath,
		JSON.stringify({
			childPidFile,
			childInheritsOutput: true,
			records: [
				{
					type: "batch",
					events: [{ kind: "result", success: true, summary: "done" }],
				},
			],
		}),
	);
	const installed: InstalledHarness = {
		definition,
		command: ["bun", FAKE_RUNNER, planPath, recordPath],
		detected: true,
		catalog: { status: "ready", diagnostics: [] },
		models: [],
	};
	const running = new HarnessRunner().start(
		installed,
		request({ projectRoot: root }),
		() => {},
	);
	expect(await running.outcome).toMatchObject({ status: "succeeded" });
	const childPid = Number(readFileSync(childPidFile, "utf8"));
	expect(processIsRunning(childPid)).toBe(false);
});

test("a successful catalog stops inherited-pipe descendants before resolving", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-catalog-leader-exited-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	const childPidFile = join(root, "child.pid");
	writeFileSync(
		planPath,
		JSON.stringify({
			childPidFile,
			childInheritsOutput: true,
			rawLines: [
				JSON.stringify({
					models: [{ id: "model", label: "Model", efforts: [] }],
				}),
			],
		}),
	);

	const installed = await HarnessRunner.install(
		definition,
		["bun", FAKE_RUNNER, planPath, recordPath],
		{ projectRoot: root, env: process.env },
	);

	expect(installed.models).toEqual([
		{ id: "model", label: "Model", efforts: [] },
	]);
	const childPid = Number(readFileSync(childPidFile, "utf8"));
	expect(processIsRunning(childPid)).toBe(false);
});

test("installation probes and catalogs in the target project with the supplied environment", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-context-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	writeFileSync(
		planPath,
		JSON.stringify({ rawLines: [JSON.stringify({ models: [] })] }),
	);

	const installed = await HarnessRunner.install(
		definition,
		["bun", FAKE_RUNNER, planPath, recordPath],
		{
			projectRoot: root,
			env: { ...process.env, PINCER_TEST_ENV_MARKER: "target-environment" },
		},
	);

	expect(JSON.parse(readFileSync(recordPath, "utf8"))).toMatchObject({
		cwd: realpathSync(root),
		envMarker: "target-environment",
	});

	writeFileSync(
		planPath,
		JSON.stringify({
			records: [
				{
					type: "batch",
					events: [{ kind: "result", success: true, summary: "done" }],
				},
			],
		}),
	);
	await new HarnessRunner().start(
		installed,
		request({ projectRoot: root }),
		() => {},
	).outcome;
	expect(JSON.parse(readFileSync(recordPath, "utf8"))).toMatchObject({
		envMarker: "target-environment",
	});
});

test("aborting installation stops an in-flight probe and its descendants", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-probe-abort-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	const childPidFile = join(root, "child.pid");
	writeFileSync(
		planPath,
		JSON.stringify({ childPidFile, waitFor: join(root, "never") }),
	);
	const controller = new AbortController();
	const installation = HarnessRunner.install(
		definition,
		["bun", FAKE_RUNNER, planPath, recordPath],
		{ projectRoot: root, env: process.env, signal: controller.signal },
	);
	while (!(await Bun.file(childPidFile).exists())) await Bun.sleep(10);
	const childPid = Number(readFileSync(childPidFile, "utf8"));

	controller.abort();

	await expect(installation).rejects.toThrow("Harness installation aborted");
	expect(processIsRunning(childPid)).toBe(false);
});

test("aborting installation stops an in-flight catalog and its descendants", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-catalog-abort-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	const childPidFile = join(root, "child.pid");
	writeFileSync(
		planPath,
		JSON.stringify({ childPidFile, waitFor: join(root, "never") }),
	);
	const abortDefinition: HarnessDefinition = {
		...definition,
		catalog: {
			models: {
				build() {
					return { argv: ["bun", FAKE_RUNNER, planPath, recordPath] };
				},
				decode() {
					return [];
				},
			},
		},
	};
	const controller = new AbortController();
	const installation = HarnessRunner.install(
		abortDefinition,
		["bun", "-e", "process.exit(0)"],
		{ projectRoot: root, env: process.env, signal: controller.signal },
	);
	while (!(await Bun.file(childPidFile).exists())) await Bun.sleep(10);
	const childPid = Number(readFileSync(childPidFile, "utf8"));

	controller.abort();

	await expect(installation).rejects.toThrow("Harness installation aborted");
	expect(processIsRunning(childPid)).toBe(false);
});

test("registry abort waits for every Harness installation to clean up", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-registry-abort-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	const childPidFile = join(root, "child.pid");
	writeFileSync(
		planPath,
		JSON.stringify({ childPidFile, waitFor: join(root, "never") }),
	);
	const controller = new AbortController();
	const resolution = resolveHarnesses({
		definitions: [
			{
				...definition,
				id: "quick-probe",
				defaultCommand: ["bun", "-e", "setInterval(() => {}, 1000)"],
				catalog: undefined,
			},
			{
				...definition,
				id: "descendant-probe",
				defaultCommand: ["bun", FAKE_RUNNER, planPath, recordPath],
				catalog: undefined,
			},
		],
		projectRoot: root,
		env: process.env,
		signal: controller.signal,
	});
	while (!(await Bun.file(childPidFile).exists())) await Bun.sleep(10);
	const childPid = Number(readFileSync(childPidFile, "utf8"));

	controller.abort();

	await expect(resolution).rejects.toThrow("Harness installation aborted");
	expect(processIsRunning(childPid)).toBe(false);
});

test("a timed-out probe terminates its descendant process group", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-probe-timeout-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	const childPidFile = join(root, "child.pid");
	writeFileSync(
		planPath,
		JSON.stringify({ childPidFile, waitFor: join(root, "never") }),
	);

	const detected = await HarnessRunner.detect(
		definition,
		["bun", FAKE_RUNNER, planPath, recordPath],
		{ projectRoot: root, env: process.env },
	);

	expect(detected).toBe(false);
	const childPid = Number(readFileSync(childPidFile, "utf8"));
	expect(processIsRunning(childPid)).toBe(false);
});

test("a timed-out catalog terminates its descendant process group", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-catalog-timeout-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	const childPidFile = join(root, "child.pid");
	writeFileSync(
		planPath,
		JSON.stringify({ childPidFile, waitFor: join(root, "never") }),
	);
	const timeoutDefinition: HarnessDefinition = {
		...definition,
		catalog: {
			models: {
				build() {
					return { argv: ["bun", FAKE_RUNNER, planPath, recordPath] };
				},
				decode() {
					return [];
				},
			},
		},
	};

	const installed = await HarnessRunner.install(
		timeoutDefinition,
		["bun", "-e", "process.exit(0)"],
		{ projectRoot: root, env: process.env },
	);

	expect(installed.detected).toBe(true);
	expect(installed.catalog).toMatchObject({ status: "failed" });
	expect(installed.catalog.diagnostics.join(" ")).toContain("timed out");
	const childPid = Number(readFileSync(childPidFile, "utf8"));
	expect(processIsRunning(childPid)).toBe(false);
});

test("installation normalizes and deduplicates advisory model records", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-runner-normalize-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	writeFileSync(
		planPath,
		JSON.stringify({
			rawLines: [
				JSON.stringify({
					models: [
						{
							id: " model-a ",
							label: " Model A ",
							efforts: [" high ", "", "high"],
						},
						{ id: "model-a", label: "duplicate", efforts: [] },
						{ id: "", label: "invalid", efforts: [] },
					],
				}),
			],
		}),
	);

	const installed = await HarnessRunner.install(
		definition,
		["bun", FAKE_RUNNER, planPath, recordPath],
		{ projectRoot: root, env: process.env },
	);
	expect(installed.models).toEqual([
		{ id: "model-a", label: "Model A", efforts: ["high"] },
	]);
});
