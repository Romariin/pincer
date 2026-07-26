import {
	existsSync,
	type FSWatcher,
	statSync,
	watch as watchFs,
} from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { stopProcessTree } from "./processTree";

/**
 * Where the proxy gets `overlay.js` from. Two shapes, picked at startup:
 *
 *   - disk:   pincer runs from the source checkout (`bun link`), so the bundle is
 *             re-read per request and a rebuild lands on the next page load — no
 *             daemon restart. Changes are also watchable, which drives live reload.
 *   - static: the compiled binary, where the bundle was baked in at build time.
 *
 * The old behaviour was static in both cases: `overlayAsset.ts` inlines the file
 * at import time, so an overlay edit stayed invisible until both a rebuild and a
 * `pincer` restart.
 */
export interface OverlaySource {
	/** Bundle text for the current request. */
	read(): Promise<string>;
	/** Absolute path when read from disk; null when baked into the binary. */
	path: string | null;
	/**
	 * The bundle can be rebuilt in place, i.e. it lives in a source checkout and
	 * not in an installed `node_modules` copy. Gates the watcher and live reload.
	 */
	watchable: boolean;
	/** Fires after the on-disk bundle changes. Returns an unsubscribe. */
	onChange(listener: () => void): () => void;
	close(): void;
}

const NOOP = (): void => {};

export function staticOverlaySource(bundle: string): OverlaySource {
	return {
		read: async () => bundle,
		path: null,
		watchable: false,
		onChange: () => NOOP,
		close: NOOP,
	};
}

/** `packages/overlay/dist/overlay.js`, relative to this file in the checkout. */
export function overlayDistPath(): string {
	return join(import.meta.dir, "..", "..", "overlay", "dist", "overlay.js");
}

export function diskOverlaySource(path: string): OverlaySource {
	const listeners = new Set<() => void>();
	// Size joins mtime in the cache key: two writes inside the same clock tick are
	// rare but real, and a differently sized bundle must never be served stale.
	let cached: { mtimeMs: number; size: number; text: string } | null = null;
	let watcher: FSWatcher | null = null;
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;
	let seen: { mtimeMs: number; size: number } | null = null;

	const scheduleNotify = (): void => {
		if (debounce) clearTimeout(debounce);
		// Vite writes in bursts; notify once the file has settled.
		debounce = setTimeout(() => {
			cached = null;
			for (const listener of listeners) listener();
		}, 250);
	};

	const stamp = (): { mtimeMs: number; size: number } | null => {
		try {
			const info = statSync(path);
			return { mtimeMs: info.mtimeMs, size: info.size };
		} catch {
			// The file is briefly absent while a rebuild swaps it in.
			return null;
		}
	};

	const ensureWatcher = (): void => {
		if (watcher || poll) return;
		// Watch the directory, not the file: a rebuild replaces the inode and a
		// file-level watch would keep pointing at the old one.
		watcher = watchFs(dirname(path), (_event, filename) => {
			if (filename && filename !== "overlay.js") return;
			seen = stamp();
			scheduleNotify();
		});
		watcher.on("error", () => {
			watcher?.close();
			watcher = null;
		});
		// Backstop: fs.watch drops events on network mounts, container bind mounts
		// and under load, and a missed rebuild would leave the page on a stale
		// bundle with no way back short of a manual refresh.
		seen = stamp();
		poll = setInterval(() => {
			const next = stamp();
			if (!next) return;
			if (seen && next.mtimeMs === seen.mtimeMs && next.size === seen.size)
				return;
			seen = next;
			scheduleNotify();
		}, 1_000);
		poll.unref?.();
	};

	return {
		async read() {
			const info = await stat(path);
			if (
				cached &&
				cached.mtimeMs === info.mtimeMs &&
				cached.size === info.size
			)
				return cached.text;
			const text = await Bun.file(path).text();
			cached = { mtimeMs: info.mtimeMs, size: info.size, text };
			return text;
		},
		path,
		// An installed copy under node_modules is a build artefact: nothing will
		// ever rewrite it, so watching it would only burn a file descriptor.
		watchable:
			!path.includes(`${sep}node_modules${sep}`) &&
			existsSync(join(dirname(dirname(path)), "vite.config.ts")),
		onChange(listener) {
			listeners.add(listener);
			ensureWatcher();
			return () => listeners.delete(listener);
		},
		close() {
			if (debounce) clearTimeout(debounce);
			debounce = null;
			if (poll) clearInterval(poll);
			poll = null;
			watcher?.close();
			watcher = null;
			listeners.clear();
		},
	};
}

export async function resolveOverlaySource(): Promise<OverlaySource> {
	const path = overlayDistPath();
	if (existsSync(path)) return diskOverlaySource(path);
	return staticOverlaySource((await import("./overlayAsset")).default);
}

export interface OverlayBuildWatcher {
	stop(): Promise<void>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: escapes are control chars by definition.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Progress chatter from `vite build --watch`; none of it is news to the user. */
const BUILD_NOISE =
	/^(?:vite v|transforming|computing|rendering|dist[/\\]|watching for file changes|build started|\d+ modules? transformed|✓ \d+ modules)/i;
/** A finished rebuild, e.g. "built in 620ms." — the one line worth a mention. */
const BUILD_DONE = /built in ([\d.]+\s*m?s)/i;

/**
 * Vite draws progress with `\r` + erase-line escapes. Left intact they rewind
 * the cursor over our own prefix (and over the ready banner), so each carriage
 * return becomes a line break and the escapes are dropped.
 */
export function overlayBuildLines(chunk: string): string[] {
	return chunk
		.replace(ANSI, "")
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Terminal-ready message for one build line, or null when it is pure noise.
 * Only the known chatter is dropped: an unrecognised line is far more likely to
 * be a build error (and its context lines) than something worth hiding.
 */
export function overlayBuildMessage(line: string): string | null {
	const done = line.match(BUILD_DONE);
	if (done) return `overlay rebuilt in ${done[1]}`;
	if (BUILD_NOISE.test(line)) return null;
	return `overlay build: ${line}`;
}

/**
 * Rebuild the overlay whenever its sources change, so an edit in
 * `packages/overlay` reaches the wrapped app without a manual `build:overlay`.
 * Only meaningful in a source checkout — returns null when the deps are missing.
 */
export function startOverlayBuild(
	distPath: string,
	log: (msg: string) => void,
): OverlayBuildWatcher | null {
	const packageDir = dirname(dirname(distPath));
	const repoRoot = dirname(dirname(packageDir));
	if (
		!existsSync(join(packageDir, "node_modules")) &&
		!existsSync(join(repoRoot, "node_modules"))
	) {
		log(
			`overlay watch skipped: no node_modules in ${packageDir} — run bun install there to auto-rebuild`,
		);
		return null;
	}

	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn({
			cmd: ["bunx", "--bun", "vite", "build", "--watch"],
			cwd: packageDir,
			// Own the whole group so the watcher dies with pincer, like the wrapped
			// dev server does.
			detached: process.platform !== "win32",
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
	} catch (error) {
		log(
			`overlay watch failed to start: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}

	const pipe = (stream: ReadableStream<Uint8Array>): void => {
		void (async () => {
			const decoder = new TextDecoder();
			const reader = stream.getReader();
			let buf = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				// Progress redraws end in \r, so only a real newline closes a line.
				const chunks = buf.split("\n");
				buf = chunks.pop() ?? "";
				for (const line of overlayBuildLines(chunks.join("\n"))) {
					const message = overlayBuildMessage(line);
					if (message) log(message);
				}
			}
		})();
	};
	pipe(child.stdout);
	pipe(child.stderr);

	return {
		async stop() {
			await stopProcessTree(child);
		},
	};
}
