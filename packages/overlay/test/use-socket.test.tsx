import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { PROTOCOL_VERSION } from "@pincer/core";
import type { ReactNode } from "react";
import { usePincerStore } from "../src/state/store";
import { useSocket } from "../src/state/useSocket";
import { FakeWebSocket, installFakeWebSocket } from "./fakeWebSocket";
import { conversation, harness, resetStore, welcome } from "./fixtures";
import { render } from "./render";

const store = () => usePincerStore.getState();

function Socket(): ReactNode {
	useSocket();
	return null;
}

let restoreWebSocket: () => void;
let mounted: { unmount(): void } | null = null;

function mount(): void {
	mounted = render(<Socket />);
}

function setPincerConfig(config: unknown): void {
	Object.defineProperty(window, "__PINCER__", {
		configurable: true,
		writable: true,
		value: config,
	});
}

beforeEach(() => {
	jest.useFakeTimers();
	resetStore();
	restoreWebSocket = installFakeWebSocket();
	setPincerConfig({ wsUrl: "ws://127.0.0.1:7391", projectRoot: "/project" });
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	restoreWebSocket();
	jest.useRealTimers();
});

/** Brings the socket to the state it reaches right after a successful welcome. */
function connect(harnesses = [harness("codex")]): FakeWebSocket {
	mount();
	const socket = FakeWebSocket.last;
	socket.open();
	socket.deliver(welcome(harnesses));
	return socket;
}

describe("app identity", () => {
	test("is taken from the Vite config and the page origin", () => {
		mount();
		expect(store()).toMatchObject({
			appRoot: "/project",
			appOrigin: "http://localhost:5173",
			settingsError: null,
		});
	});

	test("reports an error when the Vite integration did not inject a root", () => {
		setPincerConfig({ wsUrl: "ws://127.0.0.1:7391" });
		mount();
		expect(store().appRoot).toBeNull();
		expect(store().settingsError).toContain("Vite integration");
	});

	// Only the socket's own open handler clears settingsError; setConnected(false)
	// leaves it alone, so this fails if the reconnect stops replaying the identity.
	test("is replayed on every reconnect so a restarted daemon relearns it", () => {
		const socket = connect();
		usePincerStore.setState({
			settingsLoaded: true,
			settingsError: "stale failure",
		});

		socket.close();
		expect(store().settingsError).toBe("stale failure");

		jest.advanceTimersByTime(500);
		FakeWebSocket.last.open();

		expect(store()).toMatchObject({
			appRoot: "/project",
			appOrigin: "http://localhost:5173",
			settingsLoaded: false,
			settingsError: null,
		});
	});
});

describe("handshake", () => {
	test("a welcome connects the store and asks for the conversation list", () => {
		const socket = connect([harness("codex"), harness("claude")]);

		expect(store().connected).toBe(true);
		expect(store().harnesses).toHaveLength(2);
		expect(socket.frameTypes()).toEqual([
			"list_conversations",
			"get_overlay_settings",
		]);
	});

	test("an open chat is resumed before the settings request", () => {
		usePincerStore.setState({ view: "chat", conversationId: "c1" });
		const socket = connect();

		expect(socket.frameTypes()).toEqual([
			"list_conversations",
			"resume_conversation",
			"get_overlay_settings",
		]);
		expect(socket.frames()[1]?.conversationId).toBe("c1");
	});

	test("settings are not requested without an app identity", () => {
		setPincerConfig({ wsUrl: "ws://127.0.0.1:7391" });
		const socket = connect();
		expect(socket.frameTypes()).toEqual(["list_conversations"]);
	});

	test("post-welcome frames reach the store", () => {
		const socket = connect();
		socket.deliver({
			v: PROTOCOL_VERSION,
			type: "conversations",
			items: [conversation("c1")],
		});
		expect(store().conversations.map((item) => item.id)).toEqual(["c1"]);
	});
});

describe("frame rejection", () => {
	const originalError = console.error;
	beforeEach(() => {
		console.error = () => {};
	});
	afterEach(() => {
		console.error = originalError;
	});

	test("a first frame that is not a welcome closes the socket", () => {
		mount();
		const socket = FakeWebSocket.last;
		socket.open();
		socket.deliver({ v: PROTOCOL_VERSION, type: "conversations", items: [] });

		expect(socket.closeCalls).toEqual([
			{ code: 1002, reason: "Welcome required" },
		]);
		expect(store().connected).toBe(false);
	});

	test("invalid JSON closes the socket", () => {
		mount();
		const socket = FakeWebSocket.last;
		socket.open();
		socket.deliverRaw("{not json");
		expect(socket.closeCalls[0]?.reason).toBe("Invalid daemon frame");
	});

	test("a frame the parser rejects closes the socket", () => {
		mount();
		const socket = FakeWebSocket.last;
		socket.open();
		socket.deliverRaw(JSON.stringify({ v: PROTOCOL_VERSION, type: "welcome" }));
		expect(socket.closeCalls[0]?.reason).toBe("Invalid daemon frame");
	});

	test("a duplicate welcome closes the socket", () => {
		const socket = connect();
		socket.deliver(welcome([harness("codex")]));
		expect(socket.closeCalls).toEqual([
			{ code: 1002, reason: "Duplicate welcome" },
		]);
	});

	test("a protocol violation is not retried", () => {
		mount();
		const socket = FakeWebSocket.last;
		socket.open();
		socket.deliver({ v: PROTOCOL_VERSION, type: "conversations", items: [] });

		jest.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});

describe("reconnection", () => {
	test("a dropped connection disconnects the store and retries", () => {
		const socket = connect();
		socket.close();

		expect(store().connected).toBe(false);
		expect(FakeWebSocket.instances).toHaveLength(1);

		jest.advanceTimersByTime(500);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	test("the delay doubles while the daemon stays down", () => {
		mount();
		FakeWebSocket.last.close();

		jest.advanceTimersByTime(500);
		expect(FakeWebSocket.instances).toHaveLength(2);
		FakeWebSocket.last.close();

		jest.advanceTimersByTime(500);
		expect(FakeWebSocket.instances).toHaveLength(2);
		jest.advanceTimersByTime(500);
		expect(FakeWebSocket.instances).toHaveLength(3);
	});

	test("a successful welcome resets the backoff", () => {
		mount();
		FakeWebSocket.last.close();
		jest.advanceTimersByTime(500);

		const second = FakeWebSocket.last;
		second.open();
		second.deliver(welcome([harness("codex")]));
		second.close();

		jest.advanceTimersByTime(500);
		expect(FakeWebSocket.instances).toHaveLength(3);
	});

	test("a constructor that throws still schedules a retry", () => {
		FakeWebSocket.failNextConstruction = true;
		mount();
		expect(FakeWebSocket.instances).toHaveLength(0);

		jest.advanceTimersByTime(500);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	// Unmounting closes a live socket, which fires the close handler; without the
	// closed flag that handler would schedule a reconnect after the cleanup ran.
	test("unmounting a live socket does not schedule a reconnect", () => {
		connect();
		mounted?.unmount();
		mounted = null;

		jest.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	test("unmounting cancels a retry that was already scheduled", () => {
		mount();
		FakeWebSocket.last.close();
		mounted?.unmount();
		mounted = null;

		jest.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});

describe("send", () => {
	test("frames go out once the socket is open", () => {
		const socket = connect();
		store().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
		expect(socket.frameTypes().at(-1)).toBe("list_conversations");
	});

	test("frames are dropped while the socket is not open", () => {
		mount();
		const socket = FakeWebSocket.last;
		store().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
		expect(socket.sent).toEqual([]);
	});
});
