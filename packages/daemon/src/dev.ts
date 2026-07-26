import { CONTRACT_A_VERSION } from "@pincer/core";
import type { Server, ServerWebSocket, Subprocess } from "bun";
import {
	type OverlayBuildWatcher,
	type OverlaySource,
	resolveOverlaySource,
	startOverlayBuild,
	staticOverlaySource,
} from "./overlaySource";
import { stopProcessTree } from "./processTree";
import { isLocalOrigin, type RunningDaemon, startDaemon } from "./server";

/**
 * `pincer -- <cmd>`: wraps the app's own dev server behind an injection
 * proxy so the overlay works with zero per-app install. The proxy rewrites
 * HTML responses to add the `window.__PINCER__` config and the overlay loader
 * (same two tags the Vite plugin injects), serves the overlay bundle at
 * `/__pincer/overlay.js`, and pipes everything else — including HMR
 * WebSockets — through to the wrapped server untouched.
 *
 * Without the framework plugin there are no `data-pincer-source` attributes,
 * so source resolution falls back to DOM context + Harness search (Contract A
 * stays a precision upgrade, not a requirement).
 */

export interface DevProxyOptions {
	/** Upstream dev server base URL, e.g. `http://localhost:5173`. */
	target: string;
	/** Port the proxy listens on (0 = random). */
	port: number;
	/** Daemon WebSocket URL injected into the page config. */
	wsUrl: string;
	projectRoot: string;
	overlay: OverlaySource;
	/** Serve `/__pincer/reload` and inject the listener that reloads on rebuild. */
	liveReload?: boolean;
	log?: (msg: string) => void;
}

export interface RunningProxy {
	server: Server<ProxyWsData>;
	port: number;
	stop(): void;
}

export interface ProxyWsData {
	targetUrl: string;
	protocol: string | undefined;
	upstream: WebSocket | undefined;
	pending: (string | Uint8Array)[];
}

async function overlayResponse(overlay: OverlaySource): Promise<Response> {
	// Read per request: in a source checkout the file is rebuilt underneath us and
	// the next page load must get the new bundle without restarting pincer.
	return new Response(await overlay.read(), {
		headers: { "content-type": "text/javascript", "cache-control": "no-store" },
	});
}

/**
 * SSE channel the injected snippet listens on. One `data: reload` per rebuild;
 * the browser then reloads and re-fetches the (no-store) bundle.
 */
function reloadResponse(overlay: OverlaySource): Response {
	const encoder = new TextEncoder();
	let unsubscribe = (): void => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(": pincer overlay reload\n\n"));
			unsubscribe = overlay.onChange(() => {
				try {
					controller.enqueue(encoder.encode("data: reload\n\n"));
				} catch {
					unsubscribe();
				}
			});
		},
		cancel() {
			unsubscribe();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
		},
	});
}

const RELOAD_SNIPPET =
	`<script>(function(){var s=new EventSource("/__pincer/reload");` +
	`s.onmessage=function(){location.reload()}})()</script>`;

export function injectHtml(
	html: string,
	config: Record<string, unknown>,
	options: { liveReload?: boolean } = {},
): string {
	// <-escape so a "</script>" inside a config value cannot break out of the tag.
	const json = JSON.stringify(config).replace(/</g, "\\u003c");
	const cfg = `<script>window.__PINCER__=${json}</script>`;
	const loader =
		`<script type="module" src="/__pincer/overlay.js"></script>` +
		(options.liveReload ? RELOAD_SNIPPET : "");
	let out = html;
	out = out.includes("</head>")
		? out.replace("</head>", `${cfg}</head>`)
		: cfg + out;
	out = out.includes("</body>")
		? out.replace("</body>", `${loader}</body>`)
		: out + loader;
	return out;
}

/** Close codes 1005/1006/1015 are reserved "never sent on the wire" values. */
function forwardableCloseCode(code: number): number {
	return code >= 1000 &&
		code <= 4999 &&
		code !== 1005 &&
		code !== 1006 &&
		code !== 1015
		? code
		: 1000;
}

export function startDevProxy(opts: DevProxyOptions): RunningProxy {
	const target = new URL(opts.target);
	const wsTargetBase = `${target.protocol === "https:" ? "wss" : "ws"}://${target.host}`;
	const pageConfig = {
		wsUrl: opts.wsUrl,
		contractAVersion: CONTRACT_A_VERSION,
		projectRoot: opts.projectRoot,
	};

	const server = Bun.serve<ProxyWsData>({
		hostname: "127.0.0.1",
		port: opts.port,
		idleTimeout: 0,
		async fetch(req, srv) {
			const url = new URL(req.url);

			if (url.pathname === "/__pincer/overlay.js")
				return await overlayResponse(opts.overlay);

			if (url.pathname === "/__pincer/reload") {
				if (!opts.liveReload) return new Response("not found", { status: 404 });
				return reloadResponse(opts.overlay);
			}

			if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const origin = req.headers.get("origin");
				if (!isLocalOrigin(origin)) {
					return new Response("forbidden origin", { status: 403 });
				}
				// A client may offer several subprotocols but the upgrade response must
				// name exactly one; forward only the first offer to the upstream.
				const protocol = req.headers
					.get("sec-websocket-protocol")
					?.split(",")[0]
					?.trim();
				const upgraded = srv.upgrade(req, {
					data: {
						targetUrl: wsTargetBase + url.pathname + url.search,
						protocol,
						upstream: undefined,
						pending: [],
					},
					headers: protocol
						? { "sec-websocket-protocol": protocol }
						: undefined,
				});
				if (upgraded) return undefined;
				return new Response("websocket upgrade failed", { status: 400 });
			}

			const headers = new Headers(req.headers);
			headers.delete("host");
			// Ask the upstream for an identity body so HTML can be rewritten without
			// re-encoding; other content is streamed through as-is.
			headers.delete("accept-encoding");

			let upstream: Response;
			try {
				upstream = await fetch(new URL(url.pathname + url.search, target), {
					method: req.method,
					headers,
					body:
						req.method === "GET" || req.method === "HEAD"
							? undefined
							: req.body,
					redirect: "manual",
				});
			} catch {
				return new Response(
					`pincer: dev server unreachable at ${opts.target}`,
					{ status: 502 },
				);
			}

			const respHeaders = new Headers(upstream.headers);
			respHeaders.delete("content-length");
			respHeaders.delete("content-encoding");
			respHeaders.delete("transfer-encoding");

			const contentType = upstream.headers.get("content-type") ?? "";
			if (contentType.includes("text/html")) {
				const html = await upstream.text();
				return new Response(
					injectHtml(html, pageConfig, { liveReload: opts.liveReload }),
					{
						status: upstream.status,
						statusText: upstream.statusText,
						headers: respHeaders,
					},
				);
			}
			return new Response(upstream.body, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers: respHeaders,
			});
		},
		websocket: {
			open(ws: ServerWebSocket<ProxyWsData>) {
				const upstream = new WebSocket(ws.data.targetUrl, ws.data.protocol);
				ws.data.upstream = upstream;
				upstream.binaryType = "arraybuffer";
				upstream.onopen = () => {
					for (const m of ws.data.pending) upstream.send(m);
					ws.data.pending = [];
				};
				upstream.onmessage = (event) => {
					if (typeof event.data === "string") ws.send(event.data);
					else if (event.data instanceof ArrayBuffer)
						ws.send(new Uint8Array(event.data));
					else if (ArrayBuffer.isView(event.data)) {
						ws.send(
							new Uint8Array(
								event.data.buffer,
								event.data.byteOffset,
								event.data.byteLength,
							),
						);
					}
				};
				upstream.onclose = (ev) => {
					ws.close(forwardableCloseCode(ev.code), ev.reason);
				};
				upstream.onerror = () => {
					ws.close(1011, "upstream websocket error");
				};
			},
			message(ws: ServerWebSocket<ProxyWsData>, msg: string | Buffer) {
				const payload = typeof msg === "string" ? msg : new Uint8Array(msg);
				const upstream = ws.data.upstream;
				if (upstream && upstream.readyState === WebSocket.OPEN)
					upstream.send(payload);
				else ws.data.pending.push(payload);
			},
			close(ws: ServerWebSocket<ProxyWsData>, code: number, reason: string) {
				const upstream = ws.data.upstream;
				if (
					upstream &&
					(upstream.readyState === WebSocket.OPEN ||
						upstream.readyState === WebSocket.CONNECTING)
				) {
					upstream.close(forwardableCloseCode(code), reason);
				}
			},
		},
	});

	return {
		server,
		port: server.port ?? opts.port,
		stop() {
			server.stop(true);
		},
	};
}

// ---------------------------------------------------------------------------
// Child dev-server spawning + local URL detection
// ---------------------------------------------------------------------------

const LOCAL_URL_RE =
	/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CLEAR_EOL = `${CSI}K`;

/**
 * The banner is described as styled segments instead of pre-joined strings: the
 * plain render concatenates the text, the color render walks the very same
 * characters column by column so a hue wave can cross the whole box, and the
 * animation blanks trailing columns to wipe the box in. All three stay aligned
 * by construction, so stripping ANSI from any frame yields the plain banner.
 */
type BannerStyle = "frame" | "title" | "url" | "label" | "dim" | "blank";

interface BannerSegment {
	text: string;
	style: BannerStyle;
}

function bannerLines(proxyUrl: string, target: string): BannerSegment[][] {
	const rows: BannerSegment[][] = [
		[],
		[{ text: "Open this URL (Pincer proxy):", style: "label" }],
		[{ text: proxyUrl, style: "url" }],
		[],
		[{ text: `Upstream dev server: ${target}`, style: "dim" }],
		[],
	];
	const textWidth = (row: BannerSegment[]): number =>
		row.reduce((sum, seg) => sum + seg.text.length, 0);
	// 2 leading + 2 trailing spaces of gutter, same as the original box.
	const innerWidth = Math.max(44, ...rows.map((row) => textWidth(row) + 4));
	const blank = (n: number): BannerSegment => ({
		text: " ".repeat(n),
		style: "blank",
	});
	const frame = (text: string): BannerSegment => ({ text, style: "frame" });

	return [
		[
			frame("╭─ "),
			{ text: "PINCER ACTIVE", style: "title" },
			frame(` ${"─".repeat(innerWidth - 16)}╮`),
		],
		...rows.map((row) => [
			frame("│"),
			blank(2),
			...row,
			blank(innerWidth - 2 - textWidth(row)),
			frame("│"),
		]),
		[frame(`╰${"─".repeat(innerWidth)}╯`)],
	];
}

/** Full-saturation hue → rgb; the banner only ever wants vivid colors. */
export function hueToRgb(hue: number): [number, number, number] {
	const sector = (((hue % 1) + 1) % 1) * 6;
	const ramp = Math.round(255 * (1 - Math.abs((sector % 2) - 1)));
	if (sector < 1) return [255, ramp, 0];
	if (sector < 2) return [ramp, 255, 0];
	if (sector < 3) return [0, 255, ramp];
	if (sector < 4) return [0, ramp, 255];
	if (sector < 5) return [ramp, 0, 255];
	return [255, 0, ramp];
}

// The gradient walks one arc of the wheel — indigo → violet → magenta → pink →
// amber — instead of the whole ring: greens and cyans make a terminal box look
// like a toy. 1.08 wraps past red into orange, which is why it exceeds 1.
const ARC_START = 0.72;
const ARC_END = 1.08;

/**
 * Arc position 0..1 → hue. The wave ping-pongs across the arc rather than
 * looping through the excluded hues, so the animation has no seam where the
 * gradient would otherwise snap back.
 */
function arcHue(position: number): number {
	const wrapped = ((position % 1) + 1) % 1;
	const pingPong = wrapped < 0.5 ? wrapped * 2 : 2 - wrapped * 2;
	return ARC_START + (ARC_END - ARC_START) * pingPong;
}

/** Same arc in 256-color space, indigo → amber, for terminals without truecolor. */
const ARC_256 = [63, 99, 135, 171, 207, 205, 199, 198, 204, 210, 209, 215, 221];

function arcEscape(position: number, truecolor: boolean): string {
	const hue = arcHue(position);
	if (truecolor) {
		const [r, g, b] = hueToRgb(hue);
		return `${CSI}38;2;${r};${g};${b}m`;
	}
	const step = (hue - ARC_START) / (ARC_END - ARC_START);
	const index = Math.min(ARC_256.length - 1, Math.floor(step * ARC_256.length));
	return `${CSI}38;5;${ARC_256[index] ?? ARC_256[0]}m`;
}

const STYLE_ATTRS: Record<BannerStyle, string> = {
	frame: "",
	title: `${CSI}1m`,
	url: `${CSI}1;4m`,
	label: `${CSI}1;97m`,
	dim: `${CSI}2m`,
	blank: "",
};

// The gradient carries the frame, the title and the URL; prose stays a steady
// color so the box reads as text and not as a screensaver.
const GRADIENT_STYLES = new Set<BannerStyle>(["frame", "title", "url"]);

// Arc position is snapped to this many steps so neighbouring cells share one
// escape and each animation frame stays a couple of KB instead of ten.
const GRADIENT_STEPS = 48;

export interface BannerStyleOptions {
	/** Offset of the gradient wave, in arc turns; the animation walks this. */
	phase?: number;
	/** Emit 24-bit color instead of the 256-color arc. */
	truecolor?: boolean;
	/** How many columns to draw; the rest is blanked so the box wipes in. */
	reveal?: number;
}

export function formatReadyBanner(
	proxyUrl: string,
	target: string,
	color: boolean,
	style: BannerStyleOptions = {},
): string {
	const lines = bannerLines(proxyUrl, target);
	if (!color)
		return lines.map((line) => line.map((seg) => seg.text).join("")).join("\n");

	const {
		phase = 0,
		truecolor = true,
		reveal = Number.POSITIVE_INFINITY,
	} = style;
	const [topLine = []] = lines;
	const width = topLine.reduce((sum, seg) => sum + seg.text.length, 0) || 1;

	return lines
		.map((line, row) => {
			let out = "";
			let col = 0;
			let open = "";
			for (const seg of line) {
				for (const char of seg.text) {
					const hidden = col >= reveal;
					// Diagonal wave: the arc drifts along the row and down the box.
					const position =
						Math.round(
							((col / width) * 0.55 + row * 0.04 + phase) * GRADIENT_STEPS,
						) / GRADIENT_STEPS;
					const want =
						hidden || seg.style === "blank"
							? ""
							: GRADIENT_STYLES.has(seg.style)
								? STYLE_ATTRS[seg.style] + arcEscape(position, truecolor)
								: STYLE_ATTRS[seg.style];
					if (want !== open) {
						if (open) out += RESET;
						out += want;
						open = want;
					}
					out += hidden ? " " : char;
					col += 1;
				}
			}
			return open ? out + RESET : out;
		})
		.join("\n");
}

export interface PrintBannerOptions {
	proxyUrl: string;
	target: string;
	color: boolean;
	truecolor?: boolean;
	animate?: boolean;
	frames?: number;
	intervalMs?: number;
	write?: (chunk: string) => void;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Prints the banner once, or — on a color TTY — wipes it in and sweeps the
 * rainbow across it before settling. The resting frame is the plain static
 * gradient so scrollback keeps something readable.
 */
export async function printReadyBanner(
	opts: PrintBannerOptions,
): Promise<void> {
	const write =
		opts.write ?? ((chunk: string) => void process.stdout.write(chunk));
	const truecolor = opts.truecolor ?? true;
	const render = (style: BannerStyleOptions): string =>
		formatReadyBanner(opts.proxyUrl, opts.target, opts.color, {
			truecolor,
			...style,
		});

	if (!opts.color || opts.animate === false) {
		write(`\n${render({})}\n\n`);
		return;
	}

	const sleep =
		opts.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
	const frames = Math.max(1, opts.frames ?? 28);
	const intervalMs = opts.intervalMs ?? 40;
	const plainLines = formatReadyBanner(opts.proxyUrl, opts.target, false).split(
		"\n",
	);
	const lineCount = plainLines.length;
	const width = plainLines[0]?.length ?? 0;
	const wipeFrames = Math.max(1, Math.round(frames * 0.45));
	const paint = (frame: string): string =>
		`${frame
			.split("\n")
			.map((line) => `\r${line}${CLEAR_EOL}`)
			.join("\n")}\n`;

	write(`\n${CURSOR_HIDE}`);
	try {
		for (let i = 0; i < frames; i++) {
			const reveal =
				i < wipeFrames
					? Math.ceil((width * (i + 1)) / wipeFrames)
					: Number.POSITIVE_INFINITY;
			// Negative phase so the colors appear to flow left to right.
			if (i > 0) write(`${CSI}${lineCount}A`);
			write(paint(render({ reveal, phase: (-i / frames) * 2 })));
			await sleep(intervalMs);
		}
		write(`${CSI}${lineCount}A`);
		write(paint(render({})));
	} finally {
		write(`${CURSOR_SHOW}\n`);
	}
}

export function findLocalUrl(text: string): string | null {
	const match = text.replace(ANSI_RE, "").match(LOCAL_URL_RE);
	if (!match) return null;
	return match[0].replace("0.0.0.0", "127.0.0.1");
}

interface SpawnedDev {
	child: Subprocess<"inherit", "pipe", "pipe">;
	/** Resolves with the first local URL the child prints; rejects if it exits first. */
	detectedTarget: Promise<string>;
}

/**
 * Child output has to pause while the banner animation redraws in place —
 * otherwise a late "compiled successfully" lands between two frames and the
 * cursor-up math scribbles over it. Buffered chunks are flushed on release,
 * and the hold is dropped early if the child turns out to be chatty.
 */
export interface OutputGate {
	write(stream: "stdout" | "stderr", chunk: Uint8Array): void;
	hold(): void;
	release(): void;
}

const GATE_BUFFER_LIMIT = 256 * 1024;

export function createOutputGate(): OutputGate {
	let held = false;
	let buffered = 0;
	const queue: { stream: "stdout" | "stderr"; chunk: Uint8Array }[] = [];
	const passthrough = (
		stream: "stdout" | "stderr",
		chunk: Uint8Array,
	): void => {
		(stream === "stdout" ? process.stdout : process.stderr).write(chunk);
	};
	const gate: OutputGate = {
		write(stream, chunk) {
			if (!held) {
				passthrough(stream, chunk);
				return;
			}
			queue.push({ stream, chunk });
			buffered += chunk.byteLength;
			if (buffered > GATE_BUFFER_LIMIT) gate.release();
		},
		hold() {
			held = true;
		},
		release() {
			held = false;
			buffered = 0;
			for (const item of queue) passthrough(item.stream, item.chunk);
			queue.length = 0;
		},
	};
	return gate;
}

function spawnDevServer(
	command: string[],
	cwd: string,
	gate: OutputGate,
): SpawnedDev {
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
	const detectedTarget = new Promise<string>((resolve, reject) => {
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

	return { child, detectedTarget };
}

// ---------------------------------------------------------------------------
// `pincer dev` orchestration
// ---------------------------------------------------------------------------

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

	// With an explicit --target and no command, pincer only fronts an already
	// running dev server.
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
			target = await spawned.detectedTarget;
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
			log: opts.log,
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
