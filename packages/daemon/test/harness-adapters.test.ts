import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@pincer/core";
import { claudeHarness } from "../src/harnesses/claude";
import { codexHarness } from "../src/harnesses/codex";
import { ompHarness } from "../src/harnesses/omp";
import { resolveHarnesses } from "../src/harnesses/registry";
import { HarnessRunner } from "../src/harnesses/runner/harnessRunner";
import type {
	HarnessDefinition,
	HarnessTurnRequest,
	InstalledHarness,
} from "../src/harnesses/types";
import { FAKE_RUNNER } from "./harness";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function request(
	definition: HarnessDefinition,
	root: string,
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
		projectRoot: root,
		pincerDataDir: join(root, ".pincer"),
		conversationId: "conversation-1",
		selection: {
			harnessId: definition.id,
			model: "vendor/model:opaque@2026",
			effort: "Vendor-Effort/7",
		},
		resumeToken: "resume/token:opaque",
	};
}

const cases: {
	name: string;
	definition: HarnessDefinition;
	records: unknown[];
	expectedEvents: HarnessEvent[];
	expectedArgv: string[];
}[] = [
	{
		name: "Claude",
		definition: claudeHarness,
		records: [
			{
				type: "system",
				subtype: "init",
				session_id: "claude-session",
				model: "opaque",
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "changed" },
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: {
						type: "tool_use",
						name: "Edit",
						input: { file_path: "src/App.tsx" },
					},
				},
			},
			{ type: "assistant" },
			{
				type: "result",
				session_id: "claude-session",
				result: "done",
				is_error: false,
			},
		],
		expectedEvents: [
			{ kind: "status", text: "harness ready (opaque)" },
			{ kind: "session", token: "claude-session" },
			{ kind: "text", text: "changed" },
			{ kind: "tool", name: "Edit", detail: "src/App.tsx" },
			{ kind: "session", token: "claude-session" },
			{ kind: "result", success: true, summary: "done" },
		],
		expectedArgv: [
			"--model",
			"vendor/model:opaque@2026",
			"--effort",
			"Vendor-Effort/7",
			"--resume",
			"resume/token:opaque",
		],
	},
	{
		name: "Codex",
		definition: codexHarness,
		records: [
			{ type: "thread.started", thread_id: "codex-session" },
			{
				type: "item.completed",
				item: { type: "agent_message", text: "changed" },
			},
			{
				type: "item.started",
				item: { type: "command_execution", command: "git status" },
			},
			{ type: "turn.started" },
			{ type: "turn.completed" },
		],
		expectedEvents: [
			{ kind: "status", text: "codex session" },
			{ kind: "session", token: "codex-session" },
			{ kind: "text", text: "changed" },
			{ kind: "tool", name: "Bash", detail: "git status" },
			{ kind: "result", success: true, summary: "" },
		],
		expectedArgv: [
			"exec",
			"resume",
			"--json",
			"--sandbox",
			"workspace-write",
			"-m",
			"vendor/model:opaque@2026",
			"-c",
			'model_reasoning_effort="Vendor-Effort/7"',
			"resume/token:opaque",
		],
	},
	{
		name: "OMP",
		definition: ompHarness,
		records: [
			{ type: "session", id: "omp-session" },
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "changed" },
			},
			{
				type: "tool_execution_start",
				toolName: "write",
				args: { path: "src/App.tsx" },
			},
			{ type: "agent_start" },
			{ type: "agent_end" },
		],
		expectedEvents: [
			{ kind: "status", text: "omp session omp-sess" },
			{ kind: "session", token: "omp-session" },
			{ kind: "text", text: "changed" },
			{ kind: "tool", name: "write", detail: "src/App.tsx" },
			{ kind: "result", success: true, summary: "" },
		],
		expectedArgv: [
			"-r",
			"resume/token:opaque",
			"--model",
			"vendor/model:opaque@2026",
			"--thinking",
			"Vendor-Effort/7",
		],
	},
];

test.each(cases)(
	"real $name definition satisfies the shared runner contract",
	async (item) => {
		const root = mkdtempSync(join(tmpdir(), "pincer-adapter-contract-"));
		roots.push(root);
		const planPath = join(root, "plan.json");
		const recordPath = join(root, "record.json");
		writeFileSync(planPath, JSON.stringify({ records: item.records }));
		const installed: InstalledHarness = {
			definition: item.definition,
			command: ["bun", FAKE_RUNNER, planPath, recordPath],
			detected: true,
			catalog: { status: "ready", diagnostics: [] },
			models: [],
		};
		const events: HarnessEvent[] = [];

		const outcome = await new HarnessRunner().start(
			installed,
			request(item.definition, root),
			(event) => events.push(event),
		).outcome;

		expect(outcome.status).toBe("succeeded");
		expect(outcome.diagnostics).toEqual([]);
		expect(events).toEqual(item.expectedEvents);
		const recorded = JSON.parse(readFileSync(recordPath, "utf8")) as {
			argv: string[];
		};
		let cursor = 0;
		for (const argument of item.expectedArgv) {
			cursor = recorded.argv.indexOf(argument, cursor);
			expect(cursor).toBeGreaterThanOrEqual(0);
			cursor += 1;
		}
	},
);

test("registry resolution accepts injected definitions", async () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-registry-injection-"));
	roots.push(root);
	const planPath = join(root, "plan.json");
	const recordPath = join(root, "record.json");
	writeFileSync(
		planPath,
		JSON.stringify({ rawLines: [JSON.stringify({ models: [] })] }),
	);

	const resolved = await resolveHarnesses({
		definitions: [ompHarness],
		selectedId: "omp",
		commands: { omp: ["bun", FAKE_RUNNER, planPath, recordPath] },
		projectRoot: root,
		env: process.env,
	});

	expect(
		resolved.harnesses.map((installed) => installed.definition.id),
	).toEqual(["omp"]);
	expect(resolved.defaultHarnessId).toBe("omp");
});
