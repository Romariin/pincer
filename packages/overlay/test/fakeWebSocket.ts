import type { ServerMessage } from "@pincer/core";

type Listener = (event: unknown) => void;

export interface CloseCall {
	code?: number;
	reason?: string;
}

/**
 * Stands in for the browser WebSocket so a test can drive the daemon side of
 * the connection: open it, feed it frames, close it, and read back what the
 * overlay sent.
 */
export class FakeWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	/** Set to make the constructor throw, as a blocked ws:// upgrade would. */
	static failNextConstruction = false;

	readonly url: string;
	readyState = 0;
	readonly sent: string[] = [];
	readonly closeCalls: CloseCall[] = [];
	private readonly listeners = new Map<string, Listener[]>();

	constructor(url: string) {
		if (FakeWebSocket.failNextConstruction) {
			FakeWebSocket.failNextConstruction = false;
			throw new Error("connection refused");
		}
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	static reset(): void {
		FakeWebSocket.instances = [];
		FakeWebSocket.failNextConstruction = false;
	}

	static get last(): FakeWebSocket {
		const socket = FakeWebSocket.instances.at(-1);
		if (!socket) throw new Error("no socket was constructed");
		return socket;
	}

	addEventListener(type: string, listener: Listener): void {
		const existing = this.listeners.get(type) ?? [];
		existing.push(listener);
		this.listeners.set(type, existing);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason });
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.emit("close", { code, reason });
	}

	/** Completes the handshake the way the daemon accepting the socket would. */
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit("open", {});
	}

	deliver(message: ServerMessage): void {
		this.emit("message", { data: JSON.stringify(message) });
	}

	deliverRaw(data: string): void {
		this.emit("message", { data });
	}

	/** Frames the overlay sent, parsed back from the wire. */
	frames(): Array<Record<string, unknown>> {
		return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
	}

	frameTypes(): string[] {
		return this.frames().map((frame) => String(frame.type));
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

export function installFakeWebSocket(): () => void {
	const previous = globalThis.WebSocket;
	FakeWebSocket.reset();
	Object.defineProperty(globalThis, "WebSocket", {
		configurable: true,
		writable: true,
		value: FakeWebSocket,
	});
	return () => {
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: previous,
		});
		FakeWebSocket.reset();
	};
}
