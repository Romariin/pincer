import { CONTRACT_A_VERSION } from "@pincer/core";
import type { Server } from "bun";
import { isLocalOrigin } from "../localOrigin";
import type { OverlaySource } from "../overlaySource";
import { type ProxyWsData, proxyWebSocketHandlers } from "./wsBridge";

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
	wsUrl: string;
	projectRoot: string;
	overlay: OverlaySource;
	/** Serve `/__pincer/reload` and inject the listener that reloads on rebuild. */
	liveReload?: boolean;
}

export interface RunningProxy {
	server: Server<ProxyWsData>;
	port: number;
	stop(): void;
}

async function serveOverlayBundle(overlay: OverlaySource): Promise<Response> {
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
function openReloadStream(overlay: OverlaySource): Response {
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

export function injectPincerTags(
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
				return await serveOverlayBundle(opts.overlay);

			if (url.pathname === "/__pincer/reload") {
				if (!opts.liveReload) return new Response("not found", { status: 404 });
				return openReloadStream(opts.overlay);
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
					{
						status: 502,
					},
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
					injectPincerTags(html, pageConfig, { liveReload: opts.liveReload }),
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
		websocket: proxyWebSocketHandlers,
	});

	return {
		server,
		port: server.port ?? opts.port,
		stop() {
			server.stop(true);
		},
	};
}
