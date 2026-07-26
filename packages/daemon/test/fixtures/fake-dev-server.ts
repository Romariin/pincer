import { writeFileSync } from "node:fs";
import type { Server } from "bun";

const stopServerOnSignal = (server: Server<undefined>): void => {
	const stop = (): void => {
		server.stop(true);
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
};

if (Bun.argv.includes("--descendant")) {
	const descendant = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("descendant"),
	});
	stopServerOnSignal(descendant);
} else {
	const childArgs = Bun.argv.slice(2).join(" ");
	const pidFile = process.env.PINCER_FAKE_DESCENDANT_PID_FILE;
	if (pidFile) {
		const descendant = Bun.spawn({
			cmd: [process.execPath, import.meta.path, "--descendant"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "inherit",
		});
		writeFileSync(pidFile, String(descendant.pid));
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response(
				`<html><head><title>Fixture</title></head><body>fixture app; child args: ${childArgs}</body></html>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});

	console.log(`Local: http://127.0.0.1:${server.port}/`);
	stopServerOnSignal(server);
}
