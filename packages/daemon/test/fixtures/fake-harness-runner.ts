#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";

interface RunnerPlan {
	records?: unknown[];
	rawLines?: string[];
	stderr?: string;
	exitCode?: number;
	waitFor?: string;
	readyFile?: string;
	childPidFile?: string;
}

const [planPath, recordPath] = Bun.argv.slice(2);
if (!planPath || !recordPath) {
	process.stderr.write(
		"usage: fake-harness-runner <plan> <record> [argv...]\n",
	);
	process.exit(64);
}

const plan = (await Bun.file(planPath).json()) as RunnerPlan;
const stdin = await Bun.stdin.text();
await Bun.write(recordPath, JSON.stringify({ argv: Bun.argv.slice(2), stdin }));

if (plan.childPidFile) {
	const child = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	child.unref();
	writeFileSync(plan.childPidFile, String(child.pid));
}

for (const line of plan.rawLines ?? []) process.stdout.write(`${line}\n`);
for (const record of plan.records ?? [])
	process.stdout.write(`${JSON.stringify(record)}\n`);
if (plan.stderr) process.stderr.write(plan.stderr);
if (plan.readyFile) writeFileSync(plan.readyFile, "ready");
if (plan.waitFor) {
	while (!existsSync(plan.waitFor)) await Bun.sleep(10);
}
process.exit(plan.exitCode ?? 0);
