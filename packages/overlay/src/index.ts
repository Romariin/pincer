import {
  PROTOCOL_VERSION,
  SOURCE_ATTR,
  parseSourceAttr,
} from "@pincer/core";
import type {
  DomContext,
  SourceLocation,
  ServerMessage,
  ConversationSummary,
} from "@pincer/core";

interface PincerConfig {
  wsUrl?: string;
  contractAVersion?: number;
  projectRoot?: string;
  toggleKey?: string;
}

declare global {
  interface Window {
    __PINCER__?: PincerConfig;
    __PINCER_LOADED__?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap / double-injection guard
// ---------------------------------------------------------------------------
if (!window.__PINCER_LOADED__) {
  window.__PINCER_LOADED__ = true;
  start();
}

function start(): void {
  const config: PincerConfig = window.__PINCER__ ?? {};
  const wsUrl = config.wsUrl ?? `ws://127.0.0.1:7391`;
  const toggle = parseToggleKey(config.toggleKey);

  let enabled = false;
  let selected: HTMLElement | null = null;

  // -------------------------------------------------------------------------
  // WebSocket client with exponential backoff reconnect
  // -------------------------------------------------------------------------
  let ws: WebSocket | null = null;
  let backoff = 500;
  const maxBackoff = 30000;
  let conversationId: string | null = null;
  let conversations: ConversationSummary[] = [];
  let agentMissing = false;
  let connected = false;

  function connect(): void {
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
      connected = true;
      updateBadge();
      send({ v: PROTOCOL_VERSION, type: "list_conversations" });
      setStatus("connected");
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      handleMessage(msg);
    });
    socket.addEventListener("close", () => {
      ws = null;
      connected = false;
      updateBadge();
      setStatus("disconnected");
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  function scheduleReconnect(): void {
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoff);
    window.setTimeout(connect, delay);
  }

  function send(msg: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        if (msg.agent === null || (msg.agent && !msg.agent.detected)) {
          agentMissing = true;
          appendLog("No agent found — install Claude Code or configure one");
        }
        break;
      case "conversations":
        conversations = msg.items;
        break;
      case "conversation_started":
        conversationId = msg.conversation.id;
        conversations = [msg.conversation, ...conversations];
        appendLog(`conversation started: ${msg.conversation.branch}`);
        break;
      case "conversation_resumed":
        conversationId = msg.conversation.id;
        appendLog(`conversation resumed: ${msg.conversation.branch}`);
        break;
      case "blocked":
        appendLog(`blocked: ${msg.reason} — ${msg.message}`);
        break;
      case "turn_started":
        appendLog(`turn ${msg.seq} started`);
        break;
      case "agent_output": {
        const e = msg.event;
        switch (e.kind) {
          case "status":
            appendLog(`… ${e.text}`);
            break;
          case "text":
            appendLog(e.text);
            break;
          case "tool":
            appendLog(`[tool] ${e.name}${e.detail ? ` ${e.detail}` : ""}`);
            break;
          case "result":
            appendLog(`[result] ${e.success ? "ok" : "failed"}${e.summary ? `: ${e.summary}` : ""}`);
            break;
        }
        break;
      }
      case "turn_complete":
        appendLog(`done${msg.summary ? `: ${msg.summary}` : ""}`);
        break;
      case "turn_error":
        appendLog(`error: ${msg.message}`);
        break;
      case "reverted":
        appendLog(`reverted to ${msg.checkpoint}`);
        break;
      case "accepted":
        appendLog(`accepted → ${msg.mergeCommit}`);
        conversationId = null;
        break;
      case "discarded":
        appendLog("discarded");
        conversationId = null;
        break;
      case "error":
        appendLog(`error${msg.code ? ` (${msg.code})` : ""}: ${msg.message}`);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // UI container
  // -------------------------------------------------------------------------
  const container = document.createElement("div");
  container.id = "__pincer_overlay__";
  container.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none;";
  document.body.appendChild(container);

  const highlight = document.createElement("div");
  highlight.style.cssText =
    "position:fixed;pointer-events:none;outline:2px solid #e0245e;background:rgba(224,36,94,0.08);z-index:2147483647;display:none;";
  container.appendChild(highlight);

  const badge = document.createElement("div");
  badge.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;" +
    "display:none;background:#e0245e;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:6px 12px;" +
    "border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,0.35);";
  badge.textContent = "Pincer active \u2014 click an element to edit it (Esc to exit)";
  container.appendChild(badge);

  let panel: HTMLElement | null = null;
  let logArea: HTMLElement | null = null;

  function setStatus(text: string): void {
    // status surfaced only through the log when a panel is open
    if (logArea) appendLog(`[ws] ${text}`);
  }

  function appendLog(text: string): void {
    if (!logArea) return;
    const line = document.createElement("div");
    line.textContent = text;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // Highlight + selection
  // -------------------------------------------------------------------------
  function onMouseMove(e: MouseEvent): void {
    if (!enabled) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (panel && panel.contains(target)) return;
    if (container.contains(target)) return;
    const rect = target.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.top = `${rect.top}px`;
    highlight.style.left = `${rect.left}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  }

  function onClick(e: MouseEvent): void {
    if (!enabled) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (container.contains(target)) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(target);
  }

  function selectElement(el: HTMLElement): void {
    selected = el;
    const source = resolveSource(el);
    const domContext = buildDomContext(el);
    openPanel(source, domContext);
  }

  function resolveSource(el: HTMLElement): SourceLocation | null {
    let cur: HTMLElement | null = el;
    while (cur) {
      const attr = cur.getAttribute(SOURCE_ATTR);
      if (attr) {
        const parsed = parseSourceAttr(attr);
        if (parsed) return parsed;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function buildDomContext(el: HTMLElement): DomContext {
    const rawText = (el.textContent ?? "").trim().replace(/\s+/g, " ");
    const text = rawText.length > 0 ? rawText.slice(0, 80) : null;
    const ancestry: string[] = [];
    let cur: HTMLElement | null = el;
    while (cur && ancestry.length < 5) {
      ancestry.push(breadcrumb(cur));
      cur = cur.parentElement;
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id ? el.id : null,
      classes: Array.from(el.classList),
      text,
      ancestry,
    };
  }

  function breadcrumb(el: HTMLElement): string {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const classes = Array.from(el.classList);
    for (const c of classes) s += `.${c}`;
    return s;
  }

  // -------------------------------------------------------------------------
  // Prompt panel
  // -------------------------------------------------------------------------
  function openPanel(source: SourceLocation | null, domContext: DomContext): void {
    closePanel();
    const p = document.createElement("div");
    p.style.cssText =
      "position:fixed;bottom:16px;right:16px;width:340px;max-height:70vh;display:flex;flex-direction:column;" +
      "background:#1e1e1e;color:#eee;font:13px/1.4 system-ui,sans-serif;border:1px solid #444;border-radius:8px;" +
      "padding:12px;pointer-events:auto;z-index:2147483647;box-shadow:0 6px 24px rgba(0,0,0,0.4);";

    const header = document.createElement("div");
    header.style.cssText = "font-weight:600;margin-bottom:8px;word-break:break-all;";
    header.textContent = source
      ? `${source.path}:${source.line}`
      : "source unmapped — best-effort";
    p.appendChild(header);

    if (agentMissing) {
      const warn = document.createElement("div");
      warn.style.cssText = "color:#e0245e;margin-bottom:8px;";
      warn.textContent = "No agent found — install Claude Code or configure one";
      p.appendChild(warn);
    }

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Describe the change…";
    textarea.style.cssText =
      "width:100%;box-sizing:border-box;min-height:64px;resize:vertical;background:#111;color:#eee;" +
      "border:1px solid #444;border-radius:4px;padding:6px;font:inherit;";
    p.appendChild(textarea);

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;";
    p.appendChild(buttons);

    const submitBtn = mkButton("Submit", () => {
      const promptText = textarea.value.trim();
      if (!promptText) return;
      if (!conversationId) {
        send({ v: PROTOCOL_VERSION, type: "new_conversation" });
      }
      // fire prompt; if conversation is being created lazily the daemon
      // assigns/uses the active conversation. Include current known id.
      send({
        v: PROTOCOL_VERSION,
        type: "prompt",
        conversationId: conversationId ?? "",
        prompt: promptText,
        source,
        domContext,
      });
      appendLog(`> ${promptText}`);
    });
    const cancelBtn = mkButton("Cancel", () => {
      if (conversationId) send({ v: PROTOCOL_VERSION, type: "cancel", conversationId });
    });
    const revertBtn = mkButton("Revert", () => {
      if (conversationId) send({ v: PROTOCOL_VERSION, type: "revert", conversationId });
    });
    const acceptBtn = mkButton("Accept", () => {
      if (conversationId) send({ v: PROTOCOL_VERSION, type: "accept", conversationId });
    });
    const discardBtn = mkButton("Discard", () => {
      if (conversationId) send({ v: PROTOCOL_VERSION, type: "discard", conversationId });
    });
    const newBtn = mkButton("New", () => {
      send({ v: PROTOCOL_VERSION, type: "new_conversation" });
    });
    const closeBtn = mkButton("Close", () => deselect());

    buttons.append(submitBtn, cancelBtn, revertBtn, acceptBtn, discardBtn, newBtn, closeBtn);

    const log = document.createElement("div");
    log.style.cssText =
      "margin-top:8px;flex:1;overflow-y:auto;background:#111;border:1px solid #333;border-radius:4px;" +
      "padding:6px;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;min-height:60px;";
    p.appendChild(log);
    logArea = log;

    container.appendChild(p);
    panel = p;
    textarea.focus();
  }

  function mkButton(label: string, onClickFn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "background:#333;color:#eee;border:1px solid #555;border-radius:4px;padding:4px 8px;cursor:pointer;font:inherit;";
    b.addEventListener("click", (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClickFn();
    });
    return b;
  }

  function closePanel(): void {
    if (panel) {
      panel.remove();
      panel = null;
      logArea = null;
    }
  }

  function deselect(): void {
    selected = null;
    closePanel();
    highlight.style.display = "none";
  }

  // -------------------------------------------------------------------------
  // Toggle + keyboard
  // -------------------------------------------------------------------------
  function setEnabled(next: boolean): void {
    enabled = next;
    if (!enabled) {
      highlight.style.display = "none";
      deselect();
    }
    updateBadge();
  }

  function updateBadge(): void {
    if (!enabled) {
      badge.style.display = "none";
      return;
    }
    badge.style.display = "block";
    if (connected) {
      badge.style.background = "#e0245e";
      badge.textContent = "Pincer active \u2014 click an element to edit it (Esc to exit)";
    } else {
      badge.style.background = "#b26a00";
      badge.textContent = `Pincer: can't reach the daemon at ${wsUrl} \u2014 is \`pincer\` running? (Esc to exit)`;
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (matchesToggle(e)) {
      e.preventDefault();
      setEnabled(!enabled);
      return;
    }
    if (e.key === "Escape" && (enabled || selected)) {
      deselect();
    }
  }

  function matchesToggle(e: KeyboardEvent): boolean {
    if (toggle.alt && !e.altKey) return false;
    if (toggle.ctrl && !e.ctrlKey) return false;
    if (toggle.shift && !e.shiftKey) return false;
    if (toggle.meta && !e.metaKey) return false;
    // Match the physical key (`e.code`, e.g. "KeyP") so the shortcut is layout-
    // and OS-independent: on macOS, Option+P reports e.key "π", not "p".
    return (toggle.code !== null && e.code === toggle.code) || e.key.toLowerCase() === toggle.key;
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("click", onClick, true);

  console.info(`[pincer] overlay ready \u2014 press ${config.toggleKey ?? "Alt+P"} to start selecting`);

  connect();

  void selected; // referenced for lifecycle; silences unused in some flows
  void conversations;
}

// ---------------------------------------------------------------------------
// Toggle key parsing (lenient; defaults to Alt+P)
// ---------------------------------------------------------------------------
interface ParsedToggle {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
  /** Physical KeyboardEvent.code (e.g. "KeyP"), or null when key has no code mapping. */
  code: string | null;
}

function parseToggleKey(raw: string | undefined): ParsedToggle {
  const result: ParsedToggle = { alt: false, ctrl: false, shift: false, meta: false, key: "p", code: "KeyP" };
  if (!raw) return { ...result, alt: true };
  const parts = raw.split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return { ...result, alt: true };
  let sawKey = false;
  for (const part of parts) {
    if (part === "alt" || part === "option") result.alt = true;
    else if (part === "ctrl" || part === "control") result.ctrl = true;
    else if (part === "shift") result.shift = true;
    else if (part === "meta" || part === "cmd" || part === "command") result.meta = true;
    else {
      result.key = part;
      sawKey = true;
    }
  }
  if (!result.alt && !result.ctrl && !result.shift && !result.meta) result.alt = true;
  if (!sawKey) result.key = "p";
  result.code = /^[a-z]$/.test(result.key)
    ? "Key" + result.key.toUpperCase()
    : /^[0-9]$/.test(result.key)
      ? "Digit" + result.key
      : null;
  return result;
}
