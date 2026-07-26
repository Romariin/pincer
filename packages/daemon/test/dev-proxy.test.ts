import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import {
	findLocalUrl,
	injectHtml,
	startDevProxy,
	type RunningProxy,
} from "../src/dev";

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
		overlayBundle: "globalThis.__pincerTestOverlay=true;".repeat(40),
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
		overlayBundle: "globalThis.__pincerTestOverlay=true;".repeat(40),
	});

	const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
	expect(res.status).toBe(502);
});

test("injectHtml escapes </script> sequences in config values", () => {
	const out = injectHtml("<html><head></head><body></body></html>", {
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
