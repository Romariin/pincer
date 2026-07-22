import { useEffect } from "react";
import { parseServerMessage, type ClientMessage } from "@pincer/core";
import { usePincerStore } from "./store";
import { PincerClient } from "./transport";

const MAX_BACKOFF = 30_000;

/** Owns the daemon WebSocket: connect, exponential-backoff reconnect, and inject `send` into the store. */
export function useSocket(): void {
	const setSend = usePincerStore((s) => s.setSend);
	const setConnected = usePincerStore((s) => s.setConnected);
	const applyServerMessage = usePincerStore((s) => s.applyServerMessage);
	const prepareSettings = usePincerStore((s) => s.prepareSettings);

	useEffect(() => {
		const config = window.__PINCER__ ?? {};
		const wsUrl = config.wsUrl ?? "ws://127.0.0.1:7391";
		const appRoot =
			typeof config.projectRoot === "string" && config.projectRoot.length > 0
				? config.projectRoot
				: null;
		const appOrigin =
			window.location.protocol === "http:" ||
			window.location.protocol === "https:"
				? window.location.origin
				: null;
		const identityError =
			appRoot && appOrigin
				? null
				: "Pincer app identity requires the Vite integration on an HTTP(S) preview.";
		prepareSettings(appRoot, appOrigin, identityError);

		let ws: WebSocket | null = null;
		let backoff = 500;
		let closed = false;
		let timer: number | undefined;

		const send = (msg: ClientMessage): void => {
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		};
		const client = new PincerClient(send);
		setSend(send);

		const scheduleReconnect = (): void => {
			if (closed) return;
			const delay = backoff;
			backoff = Math.min(backoff * 2, MAX_BACKOFF);
			timer = window.setTimeout(connect, delay);
		};

		const connect = (): void => {
			let socket: WebSocket;
			try {
				socket = new WebSocket(wsUrl);
			} catch {
				scheduleReconnect();
				return;
			}
			ws = socket;
			let welcomed = false;
			let reconnectAllowed = true;
			socket.addEventListener("open", () => {
				prepareSettings(appRoot, appOrigin, identityError);
			});
			socket.addEventListener("message", (ev: MessageEvent) => {
				let parsed: ReturnType<typeof parseServerMessage>;
				try {
					parsed = parseServerMessage(JSON.parse(String(ev.data)));
				} catch {
					console.error("Rejected daemon frame: invalid JSON");
					reconnectAllowed = false;
					socket.close(1002, "Invalid daemon frame");
					return;
				}
				if (!parsed.ok) {
					console.error(`Rejected daemon frame: ${parsed.error}`);
					reconnectAllowed = false;
					socket.close(1002, "Invalid daemon frame");
					return;
				}
				if (!welcomed) {
					if (parsed.value.type !== "welcome") {
						console.error("Rejected daemon frame: welcome required");
						reconnectAllowed = false;
						socket.close(1002, "Welcome required");
						return;
					}
					welcomed = true;
					backoff = 500;
					setConnected(true);
					applyServerMessage(parsed.value);
					client.listConversations();
					const current = usePincerStore.getState();
					if (current.view === "chat" && current.conversationId) {
						client.resumeConversation(current.conversationId);
					}
					if (appRoot && appOrigin) {
						client.getOverlaySettings(appRoot, appOrigin);
					}
					return;
				}
				if (parsed.value.type === "welcome") {
					console.error("Rejected daemon frame: duplicate welcome");
					reconnectAllowed = false;
					socket.close(1002, "Duplicate welcome");
					return;
				}
				applyServerMessage(parsed.value);
			});
			socket.addEventListener("close", () => {
				ws = null;
				setConnected(false);
				if (reconnectAllowed) scheduleReconnect();
			});
			socket.addEventListener("error", () => socket.close());
		};

		connect();

		return () => {
			closed = true;
			clearTimeout(timer);
			ws?.close();
		};
	}, [setSend, setConnected, applyServerMessage, prepareSettings]);
}
