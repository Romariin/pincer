import { useEffect } from "react";
import { PROTOCOL_VERSION } from "@pincer/core";
import type { ClientMessage, ServerMessage } from "@pincer/core";
import { usePincerStore } from "./store";

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
			socket.addEventListener("open", () => {
				backoff = 500;
				setConnected(true);
				prepareSettings(appRoot, appOrigin, identityError);
				send({ v: PROTOCOL_VERSION, type: "list_conversations" });
				const current = usePincerStore.getState();
				if (current.view === "chat" && current.conversationId) {
					send({
						v: PROTOCOL_VERSION,
						type: "resume_conversation",
						conversationId: current.conversationId,
					});
				}
				if (appRoot && appOrigin) {
					send({
						v: PROTOCOL_VERSION,
						type: "get_overlay_settings",
						appRoot,
						appOrigin,
					});
				}
			});
			socket.addEventListener("message", (ev: MessageEvent) => {
				try {
					applyServerMessage(JSON.parse(String(ev.data)) as ServerMessage);
				} catch {
					/* ignore malformed frames */
				}
			});
			socket.addEventListener("close", () => {
				ws = null;
				setConnected(false);
				scheduleReconnect();
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
