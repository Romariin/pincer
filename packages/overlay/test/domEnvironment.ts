import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Preloaded for the whole `bun test` run, because React reads
 * `isEventSupported("input")` when `react-dom` is first evaluated: registering
 * the DOM from inside a test file is already too late and silently downgrades
 * React to its keyboard-polling change detection, so `onChange` never fires.
 *
 * happy-dom also replaces the network globals with JS implementations, which
 * breaks the daemon suites that serve and fetch over real sockets. Those are
 * handed back to Bun below — no overlay test needs the happy-dom versions.
 */
const NATIVE_GLOBALS = [
	"fetch",
	"Request",
	"Response",
	"Headers",
	"WebSocket",
	"FormData",
	"Blob",
	"File",
	"ReadableStream",
	"WritableStream",
	"TransformStream",
	"AbortController",
	"AbortSignal",
	"URL",
	"URLSearchParams",
	"TextEncoder",
	"TextDecoder",
	"crypto",
	"performance",
] as const;

if (!("document" in globalThis)) {
	const scope = globalThis as unknown as Record<string, unknown>;
	const native = new Map<string, unknown>();
	for (const name of NATIVE_GLOBALS) {
		if (name in scope) native.set(name, scope[name]);
	}

	GlobalRegistrator.register({ url: "http://localhost:5173/" });

	for (const [name, value] of native) {
		Object.defineProperty(scope, name, {
			configurable: true,
			writable: true,
			value,
		});
	}
}

// Lets React flush effects inside act() instead of warning about them.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
