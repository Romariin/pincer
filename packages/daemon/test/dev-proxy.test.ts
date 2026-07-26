import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { formatReadyBanner, printReadyBanner } from "../src/dev/banner";
import { findLocalUrl } from "../src/dev/devServer";
import { createOutputGate } from "../src/dev/outputGate";
import {
	injectPincerTags,
	type RunningProxy,
	startDevProxy,
} from "../src/dev/proxy";
import { staticOverlaySource } from "../src/overlaySource";

let upstream: Server<{ dummy?: true }> | undefined;
let proxy: RunningProxy | undefined;

afterEach(() => {
	proxy?.stop();
	proxy = undefined;
	upstream?.stop(true);
	upstream = undefined;
});

function startUpstream(): Server<{ dummy?: true }> {
	return Bun.serve<{ dummy?: true }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				if (srv.upgrade(req, { data: {} })) return undefined;
				return new Response("expected websocket", { status: 400 });
			}
			if (url.pathname === "/data.json") {
				return Response.json({ ok: true });
			}
			return new Response(
				"<html><head><title>t</title></head><body><h1>app</h1></body></html>",
				{
					headers: { "content-type": "text/html" },
				},
			);
		},
		websocket: {
			open() {},
			message(ws, msg) {
				ws.send(`echo:${msg}`);
			},
		},
	});
}

function startProxyFor(server: Server<{ dummy?: true }>): RunningProxy {
	return startDevProxy({
		target: `http://127.0.0.1:${server.port}`,
		port: 0,
		wsUrl: "ws://127.0.0.1:7391",
		projectRoot: "/tmp/example",
		overlay: staticOverlaySource(
			"globalThis.__pincerTestOverlay=true;".repeat(40),
		),
	});
}

test("injects config + overlay loader into HTML responses", async () => {
	upstream = startUpstream();
	proxy = startProxyFor(upstream);

	const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
	const html = await res.text();

	expect(html).toContain("<h1>app</h1>");
	expect(html).toContain("window.__PINCER__=");
	expect(html).toContain('"wsUrl":"ws://127.0.0.1:7391"');
	expect(html).toContain('"projectRoot":"/tmp/example"');
	expect(html).not.toContain("toggleKey");
	expect(html).toContain('src="/__pincer/overlay.js"');
	// Config lands in <head>, loader in <body>.
	expect(html.indexOf("window.__PINCER__")).toBeLessThan(
		html.indexOf("</head>"),
	);
	expect(html.indexOf("/__pincer/overlay.js")).toBeLessThan(
		html.indexOf("</body>"),
	);
});

test("passes non-HTML responses through untouched", async () => {
	upstream = startUpstream();
	proxy = startProxyFor(upstream);

	const res = await fetch(`http://127.0.0.1:${proxy.port}/data.json`);
	expect(await res.json()).toEqual({ ok: true });
});

test("serves the overlay bundle at /__pincer/overlay.js", async () => {
	upstream = startUpstream();
	proxy = startProxyFor(upstream);

	const res = await fetch(`http://127.0.0.1:${proxy.port}/__pincer/overlay.js`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("javascript");
	expect((await res.text()).length).toBeGreaterThan(1_000);
});

test("live reload stays off unless the bundle is watchable", async () => {
	upstream = startUpstream();
	proxy = startProxyFor(upstream);

	const html = await (await fetch(`http://127.0.0.1:${proxy.port}/`)).text();
	expect(html).not.toContain("EventSource");
	const res = await fetch(`http://127.0.0.1:${proxy.port}/__pincer/reload`);
	expect(res.status).toBe(404);
});

test("live reload injects a listener and opens an event stream", async () => {
	upstream = startUpstream();
	const bundle = "globalThis.__pincerTestOverlay=true;".repeat(40);
	proxy = startDevProxy({
		target: `http://127.0.0.1:${upstream.port}`,
		port: 0,
		wsUrl: "ws://127.0.0.1:7391",
		projectRoot: "/tmp/example",
		overlay: staticOverlaySource(bundle),
		liveReload: true,
	});

	const html = await (await fetch(`http://127.0.0.1:${proxy.port}/`)).text();
	expect(html).toContain('new EventSource("/__pincer/reload")');
	expect(html.indexOf("EventSource")).toBeLessThan(html.indexOf("</body>"));

	const res = await fetch(`http://127.0.0.1:${proxy.port}/__pincer/reload`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/event-stream");
	await res.body?.cancel();
});

test("proxies WebSocket traffic both ways", async () => {
	upstream = startUpstream();
	proxy = startProxyFor(upstream);

	const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`);
	const reply = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no ws reply")), 5_000);
		ws.addEventListener("open", () => ws.send("hi"));
		ws.addEventListener("message", (ev) => {
			clearTimeout(timer);
			resolve(String(ev.data));
		});
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("ws error"));
		});
	});
	ws.close();
	expect(reply).toBe("echo:hi");
});

test("returns 502 when the upstream is down", async () => {
	upstream = startUpstream();
	const deadPort = upstream.port;
	upstream.stop(true);
	upstream = undefined;

	proxy = startDevProxy({
		target: `http://127.0.0.1:${deadPort}`,
		port: 0,
		wsUrl: "ws://127.0.0.1:7391",
		projectRoot: "/tmp/example",
		overlay: staticOverlaySource(
			"globalThis.__pincerTestOverlay=true;".repeat(40),
		),
	});

	const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
	expect(res.status).toBe(502);
});

test("injectPincerTags escapes </script> sequences in config values", () => {
	const out = injectPincerTags("<html><head></head><body></body></html>", {
		projectRoot: "/tmp/</script><script>alert(1)",
	});
	expect(out).not.toContain("</script><script>alert(1)");
});

test("findLocalUrl matches plain, ANSI-colored, and 0.0.0.0 URLs", () => {
	expect(findLocalUrl("Local:   http://localhost:5173/")).toBe(
		"http://localhost:5173",
	);
	expect(
		findLocalUrl("ready on \u001b[36mhttp://127.0.0.1:3000\u001b[0m"),
	).toBe("http://127.0.0.1:3000");
	// Vite colors the port *inside* the URL; without ANSI stripping the port is lost.
	expect(findLocalUrl("Local: http://localhost:\u001b[1m5173\u001b[22m/")).toBe(
		"http://localhost:5173",
	);
	expect(findLocalUrl("listening on http://0.0.0.0:8080")).toBe(
		"http://127.0.0.1:8080",
	);
	expect(findLocalUrl("compiling...")).toBeNull();
});

test("formatReadyBanner returns the exact plain banner", () => {
	const proxyUrl = "http://localhost:4321";
	const target = "http://upstream";
	const rows = [
		"",
		"  Open this URL (Pincer proxy):",
		`  ${proxyUrl}`,
		"",
		`  Upstream dev server: ${target}`,
		"",
	];
	const expected = [
		`╭─ PINCER ACTIVE ${"─".repeat(28)}╮`,
		...rows.map((row) => `│${row.padEnd(44)}│`),
		`╰${"─".repeat(44)}╯`,
	].join("\n");

	const banner = formatReadyBanner(proxyUrl, target, false);

	expect(banner).toBe(expected);
	expect(banner).not.toContain("\u001b");
});

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string =>
	text.replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"), "");

test("formatReadyBanner paints the gradient without changing the text", () => {
	const proxyUrl = "http://localhost:4321";
	const target = "http://upstream";
	const plain = formatReadyBanner(proxyUrl, target, false);
	const colored = formatReadyBanner(proxyUrl, target, true);

	// The proxy URL is the one thing the user must act on: bold + underlined.
	expect(colored).toContain(`${ESC}[1;4m${ESC}[38;2;`);
	// The upstream is context only, so it stays dimmed and out of the gradient.
	expect(colored).toContain(`${ESC}[2mUpstream dev server: ${target}${ESC}[0m`);
	// Several distinct colors, i.e. a gradient rather than one flat fill.
	const colors = new Set(colored.match(/38;2;\d+;\d+;\d+/g) ?? []);
	expect(colors.size).toBeGreaterThan(8);
	// Color is decoration: stripping it must reproduce the plain banner exactly.
	expect(stripAnsi(colored)).toBe(plain);
});

test("formatReadyBanner keeps greens and cyans out of the gradient", () => {
	const args = ["http://localhost:4321", "http://upstream", true] as const;
	// Sweep the whole wave, not just the resting frame.
	const phases = [0, 0.17, 0.33, 0.5, 0.66, 0.83];
	const channels = phases.flatMap((phase) =>
		(
			formatReadyBanner(...args, { phase }).match(/38;2;\d+;\d+;\d+/g) ?? []
		).map((code) => code.split(";").slice(2).map(Number)),
	);

	expect(channels.length).toBeGreaterThan(50);
	for (const [r = 0, g = 0, b = 0] of channels) {
		// Green only ever shows up as the orange end of the arc (red at full).
		expect(g === 0 || r === 255).toBe(true);
		// Cyan would need green and blue together; the arc never goes there.
		expect(g > 0 && b > 0).toBe(false);
	}
});

test("formatReadyBanner falls back to the 256-color arc", () => {
	const banner = formatReadyBanner("http://localhost:4321", "http://up", true, {
		truecolor: false,
	});
	const codes = new Set(
		(banner.match(/38;5;(\d+)/g) ?? []).map((code) => Number(code.slice(5))),
	);

	expect(banner).not.toContain("38;2;");
	expect(codes.size).toBeGreaterThan(8);
	for (const code of codes) {
		// Codes 16..231 are a 6x6x6 cube indexed as 16 + 36r + 6g + b.
		const cube = code - 16;
		const r = Math.floor(cube / 36);
		const g = Math.floor((cube % 36) / 6);
		const b = cube % 6;
		expect(code).toBeGreaterThan(15);
		expect(code).toBeLessThan(232);
		// Green-dominant and cyan-ish cube cells are what looks cheap; the arc
		// never picks one.
		expect(g > r && g > b).toBe(false);
		expect(g === b && g > r).toBe(false);
	}
});

test("formatReadyBanner phase shifts the hues but not the text", () => {
	const args = ["http://localhost:4321", "http://upstream", true] as const;
	const first = formatReadyBanner(...args, { phase: 0 });
	const later = formatReadyBanner(...args, { phase: 0.3 });

	expect(later).not.toBe(first);
	expect(stripAnsi(later)).toBe(stripAnsi(first));
});

test("formatReadyBanner reveal blanks trailing columns at full width", () => {
	const args = ["http://localhost:4321", "http://upstream", true] as const;
	const plain = formatReadyBanner(...args, {}).length;
	const partial = stripAnsi(formatReadyBanner(...args, { reveal: 12 }));
	const lines = partial.split("\n");
	const full = stripAnsi(formatReadyBanner(...args, {})).split("\n");

	expect(plain).toBeGreaterThan(0);
	// Alignment is preserved: only the glyphs disappear, never the columns.
	expect(lines.map((line) => line.length)).toEqual(
		full.map((line) => line.length),
	);
	for (const [i, line] of lines.entries()) {
		expect(line.slice(0, 12)).toBe((full[i] ?? "").slice(0, 12));
		expect(line.slice(12).trim()).toBe("");
	}
});

test("printReadyBanner prints one static banner when not animating", async () => {
	const chunks: string[] = [];
	await printReadyBanner({
		proxyUrl: "http://localhost:4321",
		target: "http://upstream",
		color: false,
		animate: true,
		write: (chunk) => chunks.push(chunk),
	});

	const out = chunks.join("");
	expect(out).toBe(
		`\n${formatReadyBanner("http://localhost:4321", "http://upstream", false)}\n\n`,
	);
	expect(out).not.toContain(ESC);
});

test("printReadyBanner animates in place and restores the cursor", async () => {
	const chunks: string[] = [];
	const waits: number[] = [];
	await printReadyBanner({
		proxyUrl: "http://localhost:4321",
		target: "http://upstream",
		color: true,
		animate: true,
		frames: 4,
		intervalMs: 7,
		write: (chunk) => chunks.push(chunk),
		sleep: async (ms) => void waits.push(ms),
	});

	const out = chunks.join("");
	const plain = formatReadyBanner(
		"http://localhost:4321",
		"http://upstream",
		false,
	);
	const plainLines = plain.split("\n");
	const lineCount = plainLines.length;

	expect(waits).toEqual([7, 7, 7, 7]);
	// One cursor-up per redraw: 3 repaints plus the final settled frame.
	expect(out.split(`${ESC}[${lineCount}A`).length - 1).toBe(4);
	expect(out).toContain(`${ESC}[?25l`);
	expect(out.endsWith(`${ESC}[?25h\n`)).toBe(true);
	// Every frame is the same banner, so nothing shifts while it animates.
	const frames = stripAnsi(out)
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => line.replace(/^\r/, ""));
	const widths = new Set(frames.map((line) => line.length));
	expect(widths.size).toBe(1);
	// The proxy URL row survives the animation intact.
	expect(stripAnsi(out)).toContain((plainLines[3] ?? "").trimEnd());
});

test("createOutputGate buffers child output while held", () => {
	const written: string[] = [];
	const realStdout = process.stdout.write.bind(process.stdout);
	const realStderr = process.stderr.write.bind(process.stderr);
	const decoder = new TextDecoder();
	// biome-ignore lint/suspicious/noExplicitAny: stdout.write has overloads we do not need here.
	process.stdout.write = ((chunk: any) => {
		written.push(`out:${decoder.decode(chunk)}`);
		return true;
		// biome-ignore lint/suspicious/noExplicitAny: same as above.
	}) as any;
	// biome-ignore lint/suspicious/noExplicitAny: same as above.
	process.stderr.write = ((chunk: any) => {
		written.push(`err:${decoder.decode(chunk)}`);
		return true;
		// biome-ignore lint/suspicious/noExplicitAny: same as above.
	}) as any;

	try {
		const gate = createOutputGate();
		const bytes = (text: string) => new TextEncoder().encode(text);

		gate.write("stdout", bytes("before"));
		gate.hold();
		gate.write("stdout", bytes("during"));
		gate.write("stderr", bytes("warn"));
		expect(written).toEqual(["out:before"]);

		gate.release();
		expect(written).toEqual(["out:before", "out:during", "err:warn"]);

		// Past the buffer limit the hold gives up rather than eating memory.
		gate.hold();
		gate.write("stdout", bytes("x".repeat(300 * 1024)));
		expect(written.length).toBe(4);
		gate.write("stdout", bytes("after"));
		expect(written[4]).toBe("out:after");
	} finally {
		process.stdout.write = realStdout;
		process.stderr.write = realStderr;
	}
});

test("formatReadyBanner expands to contain a long upstream URL", () => {
	const proxyUrl = "http://localhost:4321";
	const target = `http://127.0.0.1:5173/${"nested/".repeat(12)}app`;
	const plain = formatReadyBanner(proxyUrl, target, false);
	const stripped = formatReadyBanner(proxyUrl, target, true).replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition.
		/\u001b\[[0-9;]*m/g,
		"",
	);
	const lineLengths = stripped.split("\n").map((line) => line.length);

	expect(stripped).toBe(plain);
	expect(lineLengths.every((length) => length === lineLengths[0])).toBe(true);
	expect(lineLengths[0]).toBeGreaterThan(46);
});
