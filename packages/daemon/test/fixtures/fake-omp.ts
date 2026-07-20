#!/usr/bin/env bun
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FakeOmpPlan } from "../harness";

const argv = Bun.argv.slice(2);
const rootFlag = argv.indexOf("--fake-root");
const fakeRoot = argv[rootFlag + 1];
if (rootFlag < 0 || fakeRoot === undefined) {
	process.stderr.write("fake OMP requires --fake-root <dir>\n");
	process.exit(64);
}
const kindFlag = argv.indexOf("--fake-kind");
const kind = argv[kindFlag + 1] === "claude" ? "claude" : "omp";
const plan = JSON.parse(
	readFileSync(join(fakeRoot, "plan.json"), "utf8"),
) as FakeOmpPlan;

if (argv.includes("--version")) {
	process.stdout.write("omp/0.0.0-fake\n");
	process.exit(0);
}

if (argv.includes("models") && argv.includes("--json")) {
	process.stdout.write(
		JSON.stringify(
			plan.catalog ?? {
				models: [
					{
						provider: "anthropic",
						id: "claude-opus-4-8",
						selector: "anthropic/claude-opus-4-8",
						name: "Claude Opus 4.8",
						thinking: ["low", "medium", "high", "max"],
					},
					{
						provider: "anthropic",
						id: "claude-sonnet-5",
						selector: "anthropic/claude-sonnet-5",
						name: "Claude Sonnet 5",
						thinking: null,
					},
				],
			},
		),
	);
	process.exit(0);
}

const invocationsPath = join(fakeRoot, "invocations.jsonl");
const index = existsSync(invocationsPath)
	? readFileSync(invocationsPath, "utf8").split("\n").filter(Boolean).length
	: 0;
appendFileSync(invocationsPath, `${JSON.stringify({ index, kind, argv })}\n`);
const execution = plan.executions?.[index] ?? {};

async function emit(record: unknown): Promise<void> {
	await new Promise<void>((resolve) => {
		process.stdout.write(`${JSON.stringify(record)}\n`, () => resolve());
	});
}

if (execution.spawnChildPidFile) {
	const child = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	child.unref();
	writeFileSync(join(fakeRoot, execution.spawnChildPidFile), String(child.pid));
}

const session = execution.session ?? `${kind}-session-${index + 1}`;
const text = execution.textChars
	? "x".repeat(execution.textChars)
	: (execution.text ?? `turn-${index + 1}-ready`);
if (kind === "claude") {
	await emit({
		type: "system",
		subtype: "init",
		session_id: session,
		model: "fake",
	});
	await emit({
		type: "stream_event",
		event: { type: "content_block_delta", delta: { type: "text_delta", text } },
	});
} else {
	await emit({ type: "session", version: 3, id: session });
	await emit({ type: "agent_start" });
	await emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: text },
	});
}

if (execution.waitFor) {
	const releasePath = join(fakeRoot, execution.waitFor);
	while (!existsSync(releasePath)) await Bun.sleep(10);
}

for (const edit of execution.edits ?? []) {
	const path = join(process.cwd(), edit.path);
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	writeFileSync(path, current + edit.append);
}

if (execution.emitResult !== false) {
	if (kind === "claude") {
		await emit({
			type: "result",
			is_error: false,
			session_id: session,
			result: "done",
		});
	} else {
		await emit({ type: "agent_end", messages: [] });
	}
}
process.exit(execution.exitCode ?? 0);
