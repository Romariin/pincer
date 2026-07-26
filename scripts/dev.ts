#!/usr/bin/env bun
/**
 * `bun run dev` — one command for the full inner loop, all hot-reloading:
 *
 *   - overlay: `bun build --watch` rebuilds packages/overlay/dist/overlay.js on
 *     change. The pincer Vite plugin serves that bundle fresh (no-store) and
 *     triggers a browser full-reload whenever it changes.
 *   - daemon:  `bun --watch` restarts the WebSocket daemon against examples/demo
 *     on change.
 *   - demo:    the example's Vite dev server (React Fast Refresh HMR).
 *
 * Output from each process is line-prefixed and colored. Ctrl+C (or any child
 * exiting) tears the whole group down.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const overlayDir = join(root, "packages/overlay");
const demoDir = join(root, "examples/demo");

const RESET = "\x1b[0m";

// Build the overlay once up front so the very first page load never 503s while
// the watcher's initial build is still in flight.
process.stdout.write("\x1b[35m[overlay]\x1b[0m building initial bundle…\n");
const initial = Bun.spawn({
	cmd: ["bunx", "--bun", "vite", "build"],
	cwd: overlayDir,
	stdout: "inherit",
	stderr: "inherit",
});
if ((await initial.exited) !== 0) {
	process.stderr.write("\x1b[31m[overlay] initial build failed\x1b[0m\n");
	process.exit(1);
}

interface Task {
	name: string;
	color: string;
	cmd: string[];
	cwd: string;
}

const tasks: Task[] = [
	{
		name: "overlay",
		color: "\x1b[35m", // magenta
		cwd: overlayDir,
		cmd: ["bunx", "--bun", "vite", "build", "--watch"],
	},
	{
		name: "daemon",
		color: "\x1b[36m", // cyan
		cwd: root,
		cmd: [
			"bun",
			"--watch",
			"--no-clear-screen",
			"packages/daemon/src/cli.ts",
			"--project",
			"examples/demo",
		],
	},
	{
		name: "demo",
		color: "\x1b[32m", // green
		cwd: demoDir,
		cmd: ["bun", "run", "dev"],
	},
];

const children: Bun.Subprocess[] = [];
let shuttingDown = false;

function pipe(stream: ReadableStream<Uint8Array>, prefix: string): void {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	void (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
		}
		if (buf) process.stdout.write(`${prefix}${buf}\n`);
	})();
}

function shutdown(code = 0): void {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) child.kill();
	process.exit(code);
}

for (const task of tasks) {
	const child = Bun.spawn({
		cmd: task.cmd,
		cwd: task.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const prefix = `${task.color}[${task.name}]${RESET} `;
	pipe(child.stdout as ReadableStream<Uint8Array>, prefix);
	pipe(child.stderr as ReadableStream<Uint8Array>, prefix);
	children.push(child);
	void child.exited.then((code) => {
		if (!shuttingDown) {
			process.stderr.write(`${prefix}exited (${code}) — shutting down\n`);
			shutdown(code ?? 1);
		}
	});
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
