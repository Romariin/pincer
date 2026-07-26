import { afterEach, expect, test } from "bun:test";
import { isLocalOrigin } from "../src/localOrigin";
import { createHarness, type Harness } from "./harness";

let h: Harness | undefined;

afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("isLocalOrigin allows localhost variants and non-browser clients", () => {
	expect(isLocalOrigin(null)).toBe(true);
	expect(isLocalOrigin("http://localhost:5173")).toBe(true);
	expect(isLocalOrigin("http://127.0.0.1:7392")).toBe(true);
	expect(isLocalOrigin("https://app.localhost")).toBe(true);
	expect(isLocalOrigin("http://[::1]:3000")).toBe(true);
});

test("isLocalOrigin rejects non-local and lookalike origins", () => {
	expect(isLocalOrigin("https://evil.example")).toBe(false);
	expect(isLocalOrigin("http://localhost.evil.example")).toBe(false);
	expect(isLocalOrigin("http://127.0.0.1.evil.example")).toBe(false);
	expect(isLocalOrigin("null")).toBe(false);
});

test("daemon refuses a WebSocket upgrade from a non-local origin", async () => {
	h = await createHarness();
	const res = await fetch(`http://127.0.0.1:${h.port}/`, {
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			origin: "https://evil.example",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			"sec-websocket-version": "13",
		},
	});
	expect(res.status).toBe(403);
});

// Bun's WebSocket accepts a { headers } option (needed to simulate a browser
// Origin) that the DOM constructor type does not declare.
const BunWebSocket = WebSocket as unknown as new (
	url: string,
	opts?: { headers?: Record<string, string> },
) => WebSocket;

test("daemon accepts a WebSocket upgrade from a localhost origin", async () => {
	h = await createHarness();
	const ws = new BunWebSocket(`ws://127.0.0.1:${h.port}`, {
		headers: { origin: "http://localhost:5173" },
	});
	const opened = await new Promise<boolean>((resolve) => {
		ws.addEventListener("open", () => resolve(true), { once: true });
		ws.addEventListener("error", () => resolve(false), { once: true });
	});
	ws.close();
	expect(opened).toBe(true);
});
