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

  useEffect(() => {
    const config = window.__PINCER__ ?? {};
    const wsUrl = config.wsUrl ?? "ws://127.0.0.1:7391";

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
        send({ v: PROTOCOL_VERSION, type: "list_conversations" });
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
  }, [setSend, setConnected, applyServerMessage]);
}
