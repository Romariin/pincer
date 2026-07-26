import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as babel from "@babel/core";
import { CONTRACT_A_VERSION, DEFAULT_PORT } from "@pincer/core";
import type { Plugin } from "vite";
import { pincerBabel } from "./babelPlugin";

export { pincerBabel } from "./babelPlugin";

/**
 * Vite plugin (dev-only) that tags host JSX elements with Contract A source
 * attributes, injects the Pincer overlay config + loader, and serves the built
 * overlay bundle at `/__pincer/overlay.js`.
 *
 * Tagging runs in an `enforce: "pre"` transform hook so it lands before
 * `@vitejs/plugin-react`'s JSX transform (which would otherwise collapse the
 * JSX element before a shared-pass `JSXOpeningElement` visitor could tag it).
 * JSX/TS is preserved for the downstream React transform.
 */
export default function pincer(options?: { daemonUrl?: string }): Plugin {
	let projectRoot = process.cwd();

	return {
		name: "pincer",
		apply: "serve",
		enforce: "pre",

		configResolved(c) {
			projectRoot = c.root;
		},

		transform(code, id) {
			if (id.includes("/node_modules/") || id.startsWith("\0")) return null;
			const clean = id.split("?")[0] ?? id;
			if (!/\.[jt]sx$/.test(clean)) return null;

			const result = babel.transformSync(code, {
				filename: clean,
				root: projectRoot,
				plugins: [pincerBabel({ root: projectRoot })],
				parserOpts: { plugins: ["jsx", "typescript"] },
				sourceMaps: true,
				babelrc: false,
				configFile: false,
			});
			if (!result?.code) return null;
			return { code: result.code, map: result.map ?? null };
		},

		configureServer(server) {
			// Resolve the package location once (package.json always exists), but read
			// the built bundle fresh on each request so a rebuild is picked up without
			// restarting Vite, and never cached by the browser.
			let overlayPath: string | null = null;
			try {
				const pkgJson = fileURLToPath(
					import.meta.resolve("@pincer/overlay/package.json"),
				);
				overlayPath = join(dirname(pkgJson), "dist/overlay.js");
			} catch {
				server.config.logger.warn(
					"[pincer] cannot resolve @pincer/overlay — run `bun run build:overlay`.",
				);
			}

			server.middlewares.use("/__pincer/overlay.js", (_req, res) => {
				res.setHeader("content-type", "text/javascript");
				res.setHeader("cache-control", "no-store");
				let bundle: Buffer | null = null;
				if (overlayPath) {
					try {
						bundle = readFileSync(overlayPath);
					} catch {
						bundle = null;
					}
				}
				if (!bundle) {
					res.statusCode = 503;
					res.end("// pincer overlay not built — run `bun run build:overlay`");
					return;
				}
				res.end(bundle);
			});

			// In dev the overlay is built by a separate `bun build --watch`. Watch the
			// emitted bundle and force a browser reload when it changes so overlay
			// edits hot-reload alongside app HMR. `.add()` bypasses Vite's default
			// node_modules ignore; chokidar follows the workspace symlink to the real
			// dist file.
			if (overlayPath) {
				const overlayFile = overlayPath;
				server.watcher.add(overlayFile);
				server.watcher.on("change", (file) => {
					if (resolve(file) === resolve(overlayFile)) {
						server.config.logger.info("[pincer] overlay changed — reloading");
						server.ws.send({ type: "full-reload" });
					}
				});
			}
		},

		transformIndexHtml() {
			return [
				{
					tag: "script",
					children:
						"window.__PINCER__=" +
						JSON.stringify({
							wsUrl: options?.daemonUrl ?? `ws://127.0.0.1:${DEFAULT_PORT}`,
							contractAVersion: CONTRACT_A_VERSION,
							projectRoot,
						}),
					injectTo: "head" as const,
				},
				{
					tag: "script",
					attrs: { type: "module", src: "/__pincer/overlay.js" },
					injectTo: "body" as const,
				},
			];
		},
	};
}
