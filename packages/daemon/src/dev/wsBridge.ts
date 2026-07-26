import type { ServerWebSocket, WebSocketHandler } from "bun";

export interface ProxyWsData {
	targetUrl: string;
	protocol: string | undefined;
	upstream: WebSocket | undefined;
	pending: (string | Uint8Array)[];
}

/** Close codes 1005/1006/1015 are reserved "never sent on the wire" values. */
function forwardableCloseCode(code: number): number {
	return code >= 1000 &&
		code <= 4999 &&
		code !== 1005 &&
		code !== 1006 &&
		code !== 1015
		? code
		: 1000;
}

/** Tunnels the client socket to the upstream dev server, HMR frames included. */
export const proxyWebSocketHandlers: WebSocketHandler<ProxyWsData> = {
	open(ws: ServerWebSocket<ProxyWsData>) {
		const upstream = new WebSocket(ws.data.targetUrl, ws.data.protocol);
		ws.data.upstream = upstream;
		upstream.binaryType = "arraybuffer";
		upstream.onopen = () => {
			for (const m of ws.data.pending) upstream.send(m);
			ws.data.pending = [];
		};
		upstream.onmessage = (event) => {
			if (typeof event.data === "string") ws.send(event.data);
			else if (event.data instanceof ArrayBuffer)
				ws.send(new Uint8Array(event.data));
			else if (ArrayBuffer.isView(event.data)) {
				ws.send(
					new Uint8Array(
						event.data.buffer,
						event.data.byteOffset,
						event.data.byteLength,
					),
				);
			}
		};
		upstream.onclose = (ev) => {
			ws.close(forwardableCloseCode(ev.code), ev.reason);
		};
		upstream.onerror = () => {
			ws.close(1011, "upstream websocket error");
		};
	},
	message(ws: ServerWebSocket<ProxyWsData>, msg: string | Buffer) {
		const payload = typeof msg === "string" ? msg : new Uint8Array(msg);
		const upstream = ws.data.upstream;
		if (upstream && upstream.readyState === WebSocket.OPEN)
			upstream.send(payload);
		else ws.data.pending.push(payload);
	},
	close(ws: ServerWebSocket<ProxyWsData>, code: number, reason: string) {
		const upstream = ws.data.upstream;
		if (
			upstream &&
			(upstream.readyState === WebSocket.OPEN ||
				upstream.readyState === WebSocket.CONNECTING)
		) {
			upstream.close(forwardableCloseCode(code), reason);
		}
	},
};
