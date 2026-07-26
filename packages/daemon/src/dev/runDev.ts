import {
	type OverlayBuildWatcher,
	resolveOverlaySource,
	startOverlayBuild,
	staticOverlaySource,
} from "../overlaySource";
import { stopProcessTree } from "../processTree";
import { type RunningDaemon, startDaemon } from "../server/daemon";
import { CURSOR_SHOW } from "./ansi";
import { printReadyBanner } from "./banner";
import { spawnDevServer } from "./devServer";
import { createOutputGate } from "./outputGate";
import { type RunningProxy, startDevProxy } from "./proxy";

export interface DevOptions {
	projectRoot: string;
	daemonPort: number;
	proxyPort: number;
	command: string[];
	/** Skip URL detection and proxy straight to this upstream. */
	target?: string;
	selectedHarnessId?: string;
	harnessCommands?: Record<string, string[]>;
	dataRoot?: string;
	log: (msg: string) => void;
	overlayBundle?: string;
	/** Rebuild + live-reload the overlay from a source checkout. Default: on. */
	overlayWatch?: boolean;
	signal?: AbortSignal;
}

export async function runDev(opts: DevOptions): Promise<void> {
	const overlay =
		opts.overlayBundle === undefined
			? await resolveOverlaySource()
			: staticOverlaySource(opts.overlayBundle);
	// Only a source checkout can rebuild; the compiled binary carries a fixed bundle.
	const watchOverlay =
		overlay.watchable &&
		opts.overlayWatch !== false &&
		process.env.PINCER_OVERLAY_WATCH !== "0";
	const daemon: RunningDaemon = await startDaemon({
		projectRoot: opts.projectRoot,
		port: opts.daemonPort,
		selectedHarnessId: opts.selectedHarnessId,
		harnessCommands: opts.harnessCommands,
		dataRoot: opts.dataRoot,
		log: opts.log,
		signal: opts.signal,
	});
	opts.log(
		`daemon on ws://127.0.0.1:${daemon.port}, project ${opts.projectRoot}, Harness ${daemon.orchestrator.defaultHarnessId ?? "none"}`,
	);

	const gate = createOutputGate();
	const spawned =
		opts.command.length > 0
			? spawnDevServer(opts.command, opts.projectRoot, gate)
			: null;

	// Rebuild output goes through the gate like the dev server's: a line landing
	// between two banner frames would rewind the cursor-up math and leave a
	// half-drawn box behind.
	const encoder = new TextEncoder();
	const gatedLog = (msg: string): void =>
		gate.write("stdout", encoder.encode(`[pincer] ${msg}\n`));

	let overlayBuild: OverlayBuildWatcher | null = null;
	if (watchOverlay && overlay.path) {
		overlayBuild = startOverlayBuild(overlay.path, gatedLog);
		if (overlayBuild)
			opts.log(
				"overlay: rebuilding on change; the page reloads itself when the bundle updates",
			);
	}

	let proxy: RunningProxy | undefined;
	let shutdownPromise: Promise<never> | null = null;
	const shutdown = (code: number): Promise<never> => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			// Ctrl-C mid-animation must not leave the cursor hidden.
			if (process.stdout.isTTY) process.stdout.write(CURSOR_SHOW);
			proxy?.stop();
			overlay.close();
			await Promise.all([
				spawned ? stopProcessTree(spawned.child) : Promise.resolve(),
				overlayBuild ? overlayBuild.stop() : Promise.resolve(),
				daemon.stop(),
			]);
			process.exit(code);
		})();
		return shutdownPromise;
	};
	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));
	// Closing the terminal window sends SIGHUP; without this the dev server and
	// the overlay build watcher survive as orphans.
	process.once("SIGHUP", () => void shutdown(0));
	if (spawned) void spawned.child.exited.then((code) => void shutdown(code));

	let target: string;
	if (opts.target) {
		target = opts.target;
	} else if (!spawned) {
		opts.log(
			"nothing to proxy: pass a command after -- or an explicit --target",
		);
		await shutdown(1);
		return;
	} else {
		const hint = setTimeout(() => {
			opts.log(
				"still waiting for the dev server to print a local URL — pass --target http://localhost:<port> to skip detection",
			);
		}, 15_000);
		try {
			target = await spawned.localUrl;
		} catch (err) {
			clearTimeout(hint);
			opts.log(err instanceof Error ? err.message : String(err));
			await shutdown(1);
			return;
		}
		clearTimeout(hint);
	}

	try {
		proxy = startDevProxy({
			target,
			port: opts.proxyPort,
			wsUrl: `ws://127.0.0.1:${daemon.port}`,
			projectRoot: opts.projectRoot,
			overlay,
			liveReload: overlay.watchable,
		});
	} catch (err) {
		opts.log(err instanceof Error ? err.message : String(err));
		await shutdown(1);
		return;
	}

	const color =
		Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
	// Animation redraws in place, so it needs a real TTY and an opt-out for
	// anyone piping or recording the session.
	const animate =
		color &&
		process.env.TERM !== "dumb" &&
		!process.env.CI &&
		process.env.PINCER_NO_ANIMATION === undefined;
	gate.hold();
	try {
		await printReadyBanner({
			proxyUrl: `http://localhost:${proxy.port}`,
			target,
			color,
			truecolor: /truecolor|24bit/i.test(process.env.COLORTERM ?? ""),
			animate,
		});
	} finally {
		gate.release();
	}
}
