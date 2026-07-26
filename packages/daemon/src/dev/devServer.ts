import type { Subprocess } from "bun";
import { ANSI_RE } from "./ansi";
import type { OutputGate } from "./outputGate";

const LOCAL_URL_RE =
	/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?/i;

export function findLocalUrl(text: string): string | null {
	const match = text.replace(ANSI_RE, "").match(LOCAL_URL_RE);
	if (!match) return null;
	return match[0].replace("0.0.0.0", "127.0.0.1");
}

export interface DevServerProcess {
	child: Subprocess<"inherit", "pipe", "pipe">;
	/** Resolves with the first local URL the child prints; rejects if it exits first. */
	localUrl: Promise<string>;
}

export function spawnDevServer(
	command: string[],
	cwd: string,
	gate: OutputGate,
): DevServerProcess {
	const child = Bun.spawn({
		cmd: command,
		cwd,
		env: { ...process.env, FORCE_COLOR: "1" },
		detached: process.platform !== "win32",
		stdin: "inherit",
		stdout: "pipe",
		stderr: "pipe",
	});

	let resolveTarget: (url: string) => void;
	let rejectTarget: (err: Error) => void;
	const localUrl = new Promise<string>((resolve, reject) => {
		resolveTarget = resolve;
		rejectTarget = reject;
	});

	let found = false;
	// Rolling buffer so a URL split across chunks still matches; capped since we
	// only ever need the tail.
	let scanned = "";
	const scan = (text: string): void => {
		if (found) return;
		scanned = (scanned + text).slice(-8192);
		const url = findLocalUrl(scanned);
		if (url) {
			found = true;
			resolveTarget(url);
		}
	};

	const tee = async (
		stream: ReadableStream<Uint8Array>,
		write: (chunk: Uint8Array) => void,
	): Promise<void> => {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			write(value);
			scan(decoder.decode(value, { stream: true }));
		}
	};
	void tee(child.stdout, (c) => gate.write("stdout", c));
	void tee(child.stderr, (c) => gate.write("stderr", c));

	void child.exited.then((code) => {
		if (!found)
			rejectTarget(
				new Error(
					`dev command exited with code ${code} before printing a local URL`,
				),
			);
	});

	return { child, localUrl };
}
