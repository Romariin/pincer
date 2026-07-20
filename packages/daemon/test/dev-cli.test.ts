import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitForProxyUrl(
	stream: ReadableStream<Uint8Array>,
	exited: Promise<number>,
): Promise<number> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	const ready = (async (): Promise<number> => {
		while (true) {
			const { done, value } = await reader.read();
			if (done)
				throw new Error(
					`Pincer exited before becoming ready. Output: ${output}`,
				);
			output += decoder.decode(value, { stream: true });
			const match = /pincer ready → open http:\/\/localhost:(\d+)/.exec(output);
			const port = Number(match?.[1]);
			if (Number.isInteger(port) && port > 0) return port;
		}
	})();
	const earlyExit = exited.then((code) => {
		throw new Error(
			`Pincer exited with code ${code} before becoming ready. Output: ${output}`,
		);
	});
	// External-process integration needs a wall-clock guard so a broken child cannot hang the suite.
	let timer: Timer | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(new Error(`Timed out waiting for Pincer. Output: ${output}`)),
			15_000,
		);
	});
	try {
		return await Promise.race([ready, earlyExit, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

test("pincer -- <command> launches the app through the injection proxy", async () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pincer-cli-project-"));
	const home = mkdtempSync(join(tmpdir(), "pincer-cli-home-"));
	const cli = join(import.meta.dir, "../src/cli.ts");
	const fakeDevServer = join(import.meta.dir, "fixtures/fake-dev-server.ts");
	const fakeClaude = join(import.meta.dir, "fixtures/fake-claude.ts");
	const descendantPidFile = join(home, "descendant.pid");
	const git = Bun.spawnSync(["git", "init", "-b", "main"], {
		cwd: projectRoot,
	});
	if (git.exitCode !== 0) throw new Error(git.stderr.toString());

	const child = Bun.spawn({
		cmd: [
			cli,
			"--project",
			projectRoot,
			"--port",
			"0",
			"--proxy-port",
			"0",
			"--harness",
			"claude-code",
			"--harness-command",
			JSON.stringify(["bun", fakeClaude]),
			"--",
			"bun",
			fakeDevServer,
			"--port",
			"3000",
		],
		cwd: projectRoot,
		env: {
			...process.env,
			HOME: home,
			PINCER_FAKE_DESCENDANT_PID_FILE: descendantPidFile,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let descendantPid: number | null = null;
	try {
		const proxyPort = await waitForProxyUrl(child.stdout, child.exited);
		const html = await (await fetch(`http://127.0.0.1:${proxyPort}/`)).text();
		expect(html).toContain("fixture app");
		expect(html).toContain("child args: --port 3000");
		expect(html).toContain("window.__PINCER__=");
		expect(html).toContain('src="/__pincer/overlay.js"');
		expect(existsSync(join(home, ".pincer", "settings.db"))).toBe(true);
		expect(existsSync(join(projectRoot, ".pincer"))).toBe(false);
		descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
		expect(Number.isInteger(descendantPid)).toBe(true);

		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		expect(() => process.kill(descendantPid ?? 0, 0)).toThrow();
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		if (descendantPid !== null) {
			try {
				process.kill(descendantPid, "SIGKILL");
			} catch {
				// The expected path: Pincer already terminated the full process tree.
			}
		}
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});
