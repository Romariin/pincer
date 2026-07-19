import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { isLocalOrigin } from "../src/server";
import { createHarness, type Harness } from "./harness";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function websocketUpgrade(port: number, origin: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket = connect({ host: "127.0.0.1", port }, () => {
    socket.write(
      [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Origin: ${origin}`,
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
  });
  socket.setEncoding("utf8");
  socket.once("data", (response) => {
    socket.destroy();
    resolve(String(response));
  });
  socket.once("error", reject);
  return promise;
}

test("allows loopback browser origins and local non-browser clients", () => {
  expect(isLocalOrigin(null)).toBe(true);
  expect(isLocalOrigin("http://localhost:5173")).toBe(true);
  expect(isLocalOrigin("http://127.0.0.1:7392")).toBe(true);
  expect(isLocalOrigin("https://app.localhost")).toBe(true);
  expect(isLocalOrigin("http://[::1]:3000")).toBe(true);
});

test("rejects remote and lookalike browser origins", () => {
  expect(isLocalOrigin("https://evil.example")).toBe(false);
  expect(isLocalOrigin("http://localhost.evil.example")).toBe(false);
  expect(isLocalOrigin("http://127.0.0.1.evil.example")).toBe(false);
  expect(isLocalOrigin("null")).toBe(false);
});

test("daemon rejects a WebSocket upgrade from a remote origin", async () => {
  harness = await createHarness();
  const response = await fetch(`http://127.0.0.1:${harness.port}/`, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      origin: "https://evil.example",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  });
  expect(response.status).toBe(403);
});

test("daemon accepts a WebSocket upgrade from a localhost origin", async () => {
  harness = await createHarness();
  const response = await websocketUpgrade(harness.port, "http://localhost:5173");
  expect(response.startsWith("HTTP/1.1 101")).toBe(true);
});
