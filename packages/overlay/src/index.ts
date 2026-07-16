import { PROTOCOL_VERSION, SOURCE_ATTR, parseSourceAttr } from "@pincer/core";
import type {
  DomContext,
  SourceLocation,
  ServerMessage,
  ConversationSummary,
  PromptElement,
  HarnessAvailability,
  HarnessInfo,
  MessageBlock,
} from "@pincer/core";
import { renderMarkdown, renderToolCard, renderDiff } from "./blocks";

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

const PANEL_W = 400;
const GAP = 12;
const ACCENT = "#ec1e63";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";
const FALLBACK_HARNESS: HarnessInfo = {
  id: "",
  label: "No harness",
  glyph: "?",
  c1: "#4a4a50",
  c2: "#333338",
  models: [],
  defaultModel: "",
  supportsEffort: false,
};
const EFFORT_DESC: Record<string, string> = {
  Minimal: "Fastest, least reasoning",
  Low: "Quick replies",
  Medium: "Balanced",
  High: "Deeper reasoning",
  Max: "Most thorough, slowest",
};

const SVG = {
  close:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  back:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M4 7h16M9 7V5h6v2M6 7l1 12h10l1-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none"><path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const CSS = `
#__pincer_overlay__ .pcr-hover{position:fixed;pointer-events:none;border:1.5px solid ${ACCENT};background:rgba(236,30,99,0.10);border-radius:6px;z-index:2147483646;display:none;}
#__pincer_overlay__ .pcr-sel{position:fixed;pointer-events:none;border:2px solid ${ACCENT};background:rgba(236,30,99,0.12);border-radius:6px;z-index:2147483645;}
#__pincer_overlay__ .pcr-badge{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:none;background:${ACCENT};color:#fff;font:600 12px/1.4 -apple-system,system-ui,sans-serif;padding:7px 14px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,0.4);}
#__pincer_panel__{position:fixed;top:${GAP}px;right:${GAP}px;bottom:${GAP}px;width:${PANEL_W}px;z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;background:#0d0d0f;color:#ededf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;letter-spacing:-0.006em;border-radius:20px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 30px 70px rgba(0,0,0,0.55);transform:translateX(calc(100% + ${GAP * 2}px));opacity:0;pointer-events:none;transition:transform .5s cubic-bezier(.32,.72,0,1),opacity .35s ease;}
#__pincer_panel__.pcr-open{transform:none;opacity:1;pointer-events:auto;}
@media (max-width:600px){#__pincer_panel__{left:${GAP}px;width:auto;}}
#__pincer_panel__ *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
#__pincer_panel__ button{font:inherit;}
#__pincer_panel__ ::-webkit-scrollbar{width:8px;height:8px;}
#__pincer_panel__ ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:4px;}
#__pincer_panel__ .elscroll{scrollbar-width:none;}
#__pincer_panel__ .elscroll::-webkit-scrollbar{display:none;}
#__pincer_panel__ .crow{transition:background .12s;}
#__pincer_panel__ .crow:hover{background:rgba(255,255,255,0.05);}
#__pincer_panel__ .crow:hover .cact{opacity:0.6;}
#__pincer_panel__ .cact{transition:opacity .12s;}
#__pincer_panel__ .cact:hover{opacity:1 !important;color:${ACCENT} !important;}
#__pincer_panel__ .pbtn{transition:all .13s;}
#__pincer_panel__ .pbtn:hover{background:rgba(255,255,255,0.07) !important;}
#__pincer_panel__ .selpill:hover{background:rgba(255,255,255,0.07) !important;}
#__pincer_panel__ .pta:focus{border-color:${ACCENT} !important;box-shadow:0 0 0 3px rgba(236,30,99,0.25) !important;}
#__pincer_panel__ .hbadge{position:relative;display:inline-flex;align-items:center;gap:7px;cursor:default;}
#__pincer_panel__ .htip{position:absolute;top:calc(100% + 8px);left:0;white-space:nowrap;background:#2a2a2e;color:#ededf0;font-size:12px;padding:7px 11px;border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,0.5);opacity:0;pointer-events:none;transition:opacity .14s;z-index:40;border:1px solid rgba(255,255,255,0.1);}
#__pincer_panel__ .hbadge:hover .htip{opacity:1;}
@keyframes pcr-dot{0%,60%,100%{opacity:.2}30%{opacity:1}}
@keyframes pcr-sheet{from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes pcr-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){#__pincer_panel__,#__pincer_panel__ *{transition:none !important;animation:none !important;}}
`;

if (!window.__PINCER_LOADED__) {
  window.__PINCER_LOADED__ = true;
  start();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

interface Selection {
  domEl: HTMLElement;
  source: SourceLocation | null;
  domContext: DomContext;
  box: HTMLElement;
  chip: HTMLElement;
}

function start(): void {
  const config: PincerConfig = window.__PINCER__ ?? {};
  const wsUrl = config.wsUrl ?? `ws://127.0.0.1:7391`;
  const toggle = parseToggleKey(config.toggleKey);

  // ---- state ----
  let ws: WebSocket | null = null;
  let backoff = 500;
  const maxBackoff = 30000;
  let connected = false;
  let panelOpen = false;
  let selecting = false;
  let turnRunning = false;
  let view: "list" | "chat" = "list";
  let picker: "harness" | "agent" | "effort" | null = null;

  let harnesses: HarnessAvailability[] = [];
  let efforts: string[] = ["Minimal", "Low", "Medium", "High", "Max"];
  const harnessMap = new Map<string, HarnessInfo>();
  let conversations: ConversationSummary[] = [];
  let conversationId: string | null = null;
  const draft = { harnessId: "", model: "", effort: "High" };

  const selections: Selection[] = [];
  let pendingPrompt:
    | { prompt: string; source: SourceLocation | null; domContext: DomContext; elements: PromptElement[] }
    | null = null;

  // streaming refs
  let curBody: HTMLElement | null = null;
  let curTextEl: HTMLElement | null = null;
  let curText = "";
  let curTyping: HTMLElement | null = null;
  let msgCount = 0;

  // ---- style ----
  const style = document.createElement("style");
  style.id = "__pincer_style__";
  style.textContent = CSS;
  document.head.appendChild(style);

  // ---- overlay layer (page highlights) ----
  const container = el("div", "position:fixed;z-index:2147483646;top:0;left:0;pointer-events:none;");
  container.id = "__pincer_overlay__";
  const hoverBox = el("div", "", "");
  hoverBox.className = "pcr-hover";
  const badge = el("div", "", "Click elements to add them · Esc to stop");
  badge.className = "pcr-badge";
  container.append(hoverBox, badge);
  document.body.appendChild(container);

  // ---- panel ----
  const panel = el("div", "");
  panel.id = "__pincer_panel__";

  // header
  const header = el(
    "div",
    "flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:12px;border-bottom:1px solid rgba(255,255,255,0.08);",
  );
  const backBtn = el(
    "button",
    "flex:0 0 auto;width:34px;height:34px;border-radius:8px;background:#141416;border:1px solid rgba(255,255,255,0.12);cursor:pointer;color:#cfcfd4;display:none;align-items:center;justify-content:center;",
    SVG.back,
  );
  backBtn.className = "pbtn";
  backBtn.onclick = () => showList();
  const closeBtn = el(
    "button",
    "flex:0 0 auto;width:34px;height:34px;border-radius:8px;background:#141416;border:1px solid rgba(255,255,255,0.12);cursor:pointer;color:#cfcfd4;display:flex;align-items:center;justify-content:center;",
    SVG.close,
  );
  closeBtn.className = "pbtn";
  closeBtn.onclick = () => setPanelOpen(false);
  header.append(
    backBtn,
    el("span", "font-size:17px;line-height:1;", "🦀"),
    el("span", "font-size:16px;font-weight:700;", "Pincer"),
    el("span", "flex:1;"),
    closeBtn,
  );

  // command bar
  const cmdBar = el(
    "div",
    "flex:0 0 auto;display:flex;align-items:center;background:#0d0d0f;border-bottom:1px solid rgba(255,255,255,0.08);padding:10px 12px;font-size:12.5px;",
  );
  const harnessBtn = el(
    "button",
    "display:flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:#ededf0;padding:5px 7px;border-radius:7px;font-size:12.5px;",
  );
  harnessBtn.className = "selpill";
  harnessBtn.onclick = () => openPicker("harness");
  const agentBtn = el(
    "button",
    "background:none;border:none;cursor:pointer;color:#a9a9b0;padding:5px 7px;border-radius:7px;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:150px;",
  );
  agentBtn.className = "selpill";
  agentBtn.onclick = () => openPicker("agent");
  const effortBtn = el(
    "button",
    `background:none;border:none;cursor:pointer;color:${ACCENT};padding:5px 7px;border-radius:7px;font-size:12.5px;font-weight:600;white-space:nowrap;`,
  );
  effortBtn.className = "selpill";
  effortBtn.onclick = () => openPicker("effort");
  const dot1 = el("span", "color:#48484e;", "·");
  const dot2 = el("span", "color:#48484e;", "·");
  cmdBar.append(harnessBtn, dot1, agentBtn, dot2, effortBtn);

  // middle: list + chat
  const middle = el("div", "flex:1;display:flex;flex-direction:column;min-height:0;");
  const listScroll = el("div", "flex:1;overflow-y:auto;padding:8px 8px 10px;");
  const chatWrap = el("div", "flex:1;display:none;flex-direction:column;min-height:0;");
  const thread = el("div", "flex:1;overflow-y:auto;min-height:0;padding:16px 14px 8px;display:flex;flex-direction:column;gap:18px;");
  const emptyState = el(
    "div",
    "height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:40px 30px;color:#57575e;",
    `<span style="font-size:34px;opacity:0.85;">🦀</span><div style="font-size:14px;line-height:1.6;color:#8a8a90;">Ready when you are.<br>Add an element or describe a change,<br>then hit <span style="color:${ACCENT};font-weight:600;">Send</span>.</div>`,
  );
  chatWrap.append(emptyState, thread);
  middle.append(listScroll, chatWrap);

  // element tray
  const tray = el(
    "div",
    "flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 12px 2px;min-height:40px;",
  );
  const chipsWrap = el("div", "flex:1;min-width:0;position:relative;");
  const chipsScroll = el("div", "display:flex;flex-wrap:nowrap;gap:6px;overflow-x:auto;padding:1px 0;");
  chipsScroll.className = "elscroll";
  chipsScroll.onscroll = updateFades;
  const fadeL = el("span", `position:absolute;left:0;top:0;bottom:0;width:24px;background:linear-gradient(to right,#0d0d0f,transparent);pointer-events:none;display:none;`);
  const fadeR = el("span", `position:absolute;right:0;top:0;bottom:0;width:24px;background:linear-gradient(to left,#0d0d0f,transparent);pointer-events:none;display:none;`);
  chipsWrap.append(chipsScroll, fadeL, fadeR);
  const noEls = el("span", "flex:1;color:#77777e;font-size:13px;", "No elements selected");
  const addBtn = el(
    "button",
    "flex:0 0 auto;display:flex;align-items:center;gap:6px;background:#1c1c1f;border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:7px 12px;cursor:pointer;color:#ededf0;font-size:13px;font-weight:600;",
    `${SVG.plus}Add element`,
  );
  addBtn.className = "pbtn";
  addBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSelecting(!selecting);
  };
  tray.append(chipsWrap, noEls, addBtn);

  // composer
  const composer = el("div", "flex:0 0 auto;padding:8px 12px 14px;");
  const textarea = el(
    "textarea",
    "width:100%;background:#141416;border:1px solid rgba(255,255,255,0.14);border-radius:10px;padding:11px 12px;color:#ededf0;font-family:inherit;font-size:13.5px;resize:none;outline:none;line-height:1.45;transition:border-color .13s,box-shadow .13s;",
  ) as HTMLTextAreaElement;
  textarea.className = "pta";
  textarea.rows = 3;
  textarea.placeholder = "Describe a change to start a new chat…";
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  const sendRow = el("div", "display:flex;gap:8px;margin-top:10px;");
  const sendBtn = el(
    "button",
    `flex:1;background:${ACCENT};border:none;border-radius:9px;padding:12px;cursor:pointer;color:#fff;font-size:14px;font-weight:700;box-shadow:0 2px 12px rgba(236,30,99,0.35);`,
    "Send",
  );
  sendBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (turnRunning && conversationId) send({ v: PROTOCOL_VERSION, type: "cancel", conversationId });
    else submit();
  };
  const acceptBtn = el(
    "button",
    "flex:0 0 auto;background:#1c1c1f;border:1px solid rgba(255,255,255,0.14);border-radius:9px;padding:12px 18px;cursor:pointer;color:#ededf0;font-size:14px;font-weight:600;display:none;",
    "Accept",
  );
  acceptBtn.className = "pbtn";
  acceptBtn.onclick = () => {
    if (conversationId) send({ v: PROTOCOL_VERSION, type: "accept", conversationId });
  };
  const discardBtn = el(
    "button",
    "flex:0 0 auto;background:#1c1c1f;border:1px solid rgba(255,255,255,0.14);border-radius:9px;padding:12px 18px;cursor:pointer;color:#ededf0;font-size:14px;font-weight:600;display:none;",
    "Discard",
  );
  discardBtn.className = "pbtn";
  discardBtn.onclick = () => {
    if (conversationId) send({ v: PROTOCOL_VERSION, type: "discard", conversationId });
  };
  sendRow.append(sendBtn, acceptBtn, discardBtn);
  composer.append(textarea, sendRow);

  // picker sheet
  const pickerBackdrop = el(
    "div",
    "position:absolute;inset:0;background:rgba(0,0,0,0.55);z-index:20;animation:pcr-fade .2s ease;display:none;",
  );
  pickerBackdrop.onclick = () => closePicker();
  const pickerSheet = el(
    "div",
    "position:absolute;left:0;right:0;bottom:0;z-index:21;background:#141416;border-top:1px solid rgba(255,255,255,0.12);border-radius:18px 18px 0 0;padding:8px 0 18px;max-height:76%;display:none;flex-direction:column;",
  );
  const pickerTitle = el("div", "font-size:11px;font-weight:700;letter-spacing:0.1em;color:#77777e;padding:10px 20px 12px;");
  const pickerList = el("div", "overflow-y:auto;padding:0 10px;");
  pickerSheet.append(
    el("div", "width:36px;height:4px;border-radius:2px;background:#3a3a3e;margin:6px auto 4px;"),
    pickerTitle,
    pickerList,
  );

  panel.append(header, cmdBar, middle, tray, composer, pickerBackdrop, pickerSheet);
  document.body.appendChild(panel);

  // -------------------------------------------------------------------------
  // Harness helpers
  // -------------------------------------------------------------------------
  function harnessInfo(id: string): HarnessInfo {
    return harnessMap.get(id) ?? FALLBACK_HARNESS;
  }

  function avatar(info: HarnessInfo, size: number): HTMLElement {
    const r = Math.round(size * 0.28);
    const a = el(
      "span",
      `flex:0 0 auto;width:${size}px;height:${size}px;border-radius:${r}px;background:linear-gradient(145deg,${info.c1},${info.c2});display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:${Math.round(size * 0.42)}px;font-weight:700;font-family:${MONO};box-shadow:inset 0 1px 0 rgba(255,255,255,0.22);letter-spacing:-0.02em;`,
    );
    a.textContent = info.glyph;
    return a;
  }

  function cfg(): { harnessId: string; model: string; effort: string } {
    if (view === "chat" && conversationId) {
      const c = conversations.find((x) => x.id === conversationId);
      if (c) return { harnessId: c.harnessId, model: c.model, effort: c.effort };
    }
    return { ...draft };
  }

  function modelLabel(info: HarnessInfo, id: string): string {
    return info.models.find((m) => m.id === id)?.label ?? (id || "Default");
  }

  function updateCfg(patch: Partial<{ harnessId: string; model: string; effort: string }>): void {
    if (view === "chat" && conversationId) {
      conversations = conversations.map((c) => (c.id === conversationId ? { ...c, ...patch } : c));
      send({ v: PROTOCOL_VERSION, type: "set_config", conversationId, ...patch });
    } else {
      Object.assign(draft, patch);
    }
    renderCmdBar();
  }

  function renderCmdBar(): void {
    const c = cfg();
    const info = harnessInfo(c.harnessId);
    harnessBtn.textContent = "";
    harnessBtn.append(avatar(info, 18), el("span", "font-weight:600;", info.label));
    agentBtn.textContent = modelLabel(info, c.model);
    effortBtn.textContent = c.effort;
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------
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
      send({ v: PROTOCOL_VERSION, type: "list_conversations" });
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      try {
        handleMessage(JSON.parse(String(ev.data)) as ServerMessage);
      } catch {
        /* ignore */
      }
    });
    socket.addEventListener("close", () => {
      ws = null;
      connected = false;
      scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  function scheduleReconnect(): void {
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoff);
    window.setTimeout(connect, delay);
  }

  function send(msg: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------
  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome": {
        harnesses = msg.harnesses;
        efforts = msg.efforts.length ? msg.efforts : efforts;
        harnessMap.clear();
        for (const h of harnesses) harnessMap.set(h.id, h);
        const def = msg.defaultHarnessId ?? harnesses.find((h) => h.detected)?.id ?? harnesses[0]?.id ?? "";
        draft.harnessId = def;
        draft.model = harnessInfo(def).defaultModel;
        if (!efforts.includes(draft.effort)) draft.effort = efforts[efforts.length - 2] ?? efforts[0] ?? "High";
        renderCmdBar();
        break;
      }
      case "conversations":
        conversations = msg.items;
        if (view === "list") renderList();
        break;
      case "conversation_started":
        conversationId = msg.conversation.id;
        conversations = [msg.conversation, ...conversations.filter((c) => c.id !== msg.conversation.id)];
        clearThread();
        showChat();
        if (pendingPrompt) {
          send({ v: PROTOCOL_VERSION, type: "prompt", conversationId, ...pendingPrompt });
          addUserMessage(pendingPrompt.prompt, pendingPrompt.elements.length);
          pendingPrompt = null;
        }
        break;
      case "conversation_resumed":
        conversationId = msg.conversation.id;
        conversations = [msg.conversation, ...conversations.filter((c) => c.id !== msg.conversation.id)];
        clearThread();
        for (const t of msg.turns) {
          addUserMessage(t.prompt, 0);
          if (t.blocks.length) renderResumedAssistant(t.blocks);
        }
        showChat();
        break;
      case "config_updated":
        conversations = conversations.map((c) => (c.id === msg.conversation.id ? msg.conversation : c));
        renderCmdBar();
        break;
      case "deleted":
        conversations = conversations.filter((c) => c.id !== msg.conversationId);
        renderList();
        break;
      case "blocked":
        pendingPrompt = null;
        setTurnRunning(false);
        sysNote(msg.message);
        break;
      case "turn_started":
        setTurnRunning(true);
        beginAssistant();
        break;
      case "agent_output": {
        const e = msg.event;
        if (e.kind === "text") appendText(e.text);
        else if (e.kind === "tool") addTool(e.name, e.detail);
        else if (e.kind === "diff") addDiff(e.file, e.hunks);
        else if (e.kind === "status" && e.text) {
          /* status shown only as typing; ignore text */
        }
        break;
      }
      case "turn_complete":
        finishAssistant();
        setTurnRunning(false);
        send({ v: PROTOCOL_VERSION, type: "list_conversations" });
        break;
      case "turn_error":
        finishAssistant();
        setTurnRunning(false);
        sysNote(`Error: ${msg.message}`);
        break;
      case "accepted":
      case "discarded":
        conversationId = null;
        showList();
        send({ v: PROTOCOL_VERSION, type: "list_conversations" });
        break;
      case "error":
        sysNote(msg.message);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // List rendering
  // -------------------------------------------------------------------------
  function groupLabel(ts: number): string {
    const now = new Date();
    const d = new Date(ts);
    const same = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(now, d)) return "TODAY";
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (same(y, d)) return "YESTERDAY";
    return "EARLIER";
  }

  function renderList(): void {
    listScroll.textContent = "";
    if (conversations.length === 0) {
      listScroll.appendChild(
        el(
          "div",
          "padding:60px 30px;text-align:center;color:#77777e;font-size:13.5px;line-height:1.6;",
          `No conversations yet.<br>Describe a change below to start one.`,
        ),
      );
      return;
    }
    const order = ["TODAY", "YESTERDAY", "EARLIER"];
    const groups = new Map<string, ConversationSummary[]>();
    for (const c of conversations) {
      const g = groupLabel(c.updatedAt);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(c);
    }
    for (const g of order) {
      const items = groups.get(g);
      if (!items || items.length === 0) continue;
      const gh = el("div", "display:flex;align-items:center;gap:10px;padding:15px 8px 7px;");
      gh.append(
        el("span", "font-size:10.5px;font-weight:700;letter-spacing:0.12em;color:#6b6b72;", g),
        el("span", "flex:1;height:1px;background:rgba(255,255,255,0.06);"),
      );
      listScroll.appendChild(gh);
      for (const c of items) listScroll.appendChild(row(c));
    }
  }

  function row(c: ConversationSummary): HTMLElement {
    const info = harnessInfo(c.harnessId);
    const r = el("div", "display:flex;align-items:center;gap:11px;padding:10px;border-radius:9px;cursor:pointer;");
    r.className = "crow";
    const main = el("div", "flex:1;min-width:0;");
    main.append(
      el(
        "div",
        "font-size:13.5px;color:#e2e2e7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
        undefined,
      ),
      el("div", "font-size:11.5px;color:#77777e;margin-top:2px;", undefined),
    );
    (main.children[0] as HTMLElement).textContent = c.title?.trim() || "New conversation";
    (main.children[1] as HTMLElement).textContent = c.turnCount
      ? `${info.label} · ${modelLabel(info, c.model)}`
      : "No messages yet";
    const del = el(
      "button",
      "flex:0 0 auto;opacity:0;background:none;border:none;cursor:pointer;color:#77777e;padding:2px;display:flex;",
      SVG.trash,
    );
    del.className = "cact";
    del.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      send({ v: PROTOCOL_VERSION, type: "delete_conversation", conversationId: c.id });
    };
    r.append(avatar(info, 28), main, del);
    r.onclick = () => {
      if (c.id === conversationId) showChat();
      else send({ v: PROTOCOL_VERSION, type: "resume_conversation", conversationId: c.id });
    };
    return r;
  }

  // -------------------------------------------------------------------------
  // Thread rendering
  // -------------------------------------------------------------------------
  function clearThread(): void {
    thread.textContent = "";
    curBody = null;
    curTextEl = null;
    curText = "";
    curTyping = null;
    msgCount = 0;
    updateEmpty();
  }

  function updateEmpty(): void {
    emptyState.style.display = msgCount === 0 ? "flex" : "none";
    thread.style.display = msgCount === 0 ? "none" : "flex";
  }

  function scrollThread(): void {
    thread.scrollTop = thread.scrollHeight;
  }

  function sysNote(text: string): void {
    if (view !== "chat") return;
    const n = el("div", "align-self:center;color:#8a8a90;font-size:11.5px;text-align:center;", "");
    n.textContent = text;
    thread.appendChild(n);
    msgCount++;
    updateEmpty();
    scrollThread();
  }

  function addUserMessage(text: string, count: number): void {
    const bubble = el(
      "div",
      "align-self:flex-end;max-width:88%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:13px 13px 4px 13px;padding:9px 13px;font-size:13.5px;line-height:1.5;color:#e6e6ea;word-break:break-word;",
      renderMarkdown(text),
    );
    if (count > 0) {
      const wrap = el("div", "align-self:flex-end;display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:88%;");
      wrap.append(el("div", `font-size:10.5px;font-weight:600;color:${ACCENT};`, `${count} element${count === 1 ? "" : "s"}`), bubble);
      thread.appendChild(wrap);
    } else {
      thread.appendChild(bubble);
    }
    msgCount++;
    updateEmpty();
    scrollThread();
  }

  function metaBadge(): HTMLElement {
    const c = cfg();
    const info = harnessInfo(c.harnessId);
    const b = el("div", "font-size:12px;");
    const badgeEl = el("span", "");
    badgeEl.className = "hbadge";
    badgeEl.append(avatar(info, 18), el("span", "color:#c9c9d0;font-weight:600;", info.label));
    const tip = el("span", "");
    tip.className = "htip";
    tip.append(
      el("span", "color:#8a8a90;", "agent "),
      el("span", "font-weight:600;", modelLabel(info, c.model)),
      el("span", "color:#8a8a90;", "   effort "),
      el("span", `font-weight:600;color:${ACCENT};`, c.effort),
    );
    badgeEl.appendChild(tip);
    b.appendChild(badgeEl);
    return b;
  }

  function beginAssistant(): void {
    const wrap = el("div", "align-self:stretch;display:flex;flex-direction:column;gap:9px;");
    wrap.appendChild(metaBadge());
    const body = el("div", "font-size:13.5px;line-height:1.6;color:#c9c9d0;display:flex;flex-direction:column;gap:10px;");
    const typing = el(
      "div",
      "display:flex;gap:5px;padding:4px 0;",
      [0, 1, 2]
        .map(
          (i) =>
            `<span style="width:7px;height:7px;border-radius:50%;background:${ACCENT};animation:pcr-dot 1.2s infinite;animation-delay:${i * 0.18}s;"></span>`,
        )
        .join(""),
    );
    body.appendChild(typing);
    wrap.appendChild(body);
    thread.appendChild(wrap);
    curBody = body;
    curTyping = typing;
    curTextEl = null;
    curText = "";
    msgCount++;
    updateEmpty();
    scrollThread();
  }

  function ensureBody(): HTMLElement {
    if (!curBody) beginAssistant();
    return curBody!;
  }

  function appendText(delta: string): void {
    const body = ensureBody();
    if (curTyping) {
      curTyping.remove();
      curTyping = null;
    }
    if (!curTextEl) {
      curText = "";
      curTextEl = el("div", "");
      body.appendChild(curTextEl);
    }
    curText += delta;
    curTextEl.innerHTML = renderMarkdown(curText);
    scrollThread();
  }

  function addTool(name: string, detail?: string): void {
    const body = ensureBody();
    if (curTyping) {
      curTyping.remove();
      curTyping = null;
    }
    curTextEl = null;
    body.appendChild(el("div", "", renderToolCard(name, detail)).firstElementChild as HTMLElement);
    scrollThread();
  }

  function addDiff(file: string, hunks: { type: "add" | "del" | "ctx"; text: string }[]): void {
    const body = ensureBody();
    if (curTyping) {
      curTyping.remove();
      curTyping = null;
    }
    curTextEl = null;
    body.appendChild(el("div", "", renderDiff(file, hunks)).firstElementChild as HTMLElement);
    scrollThread();
  }

  function finishAssistant(): void {
    if (curTyping) {
      curTyping.remove();
      curTyping = null;
    }
    if (curBody && !curBody.hasChildNodes()) {
      curBody.parentElement?.remove();
      msgCount = Math.max(0, msgCount - 1);
      updateEmpty();
    }
    curBody = null;
    curTextEl = null;
    curText = "";
  }

  function renderResumedAssistant(blocks: MessageBlock[]): void {
    const wrap = el("div", "align-self:stretch;display:flex;flex-direction:column;gap:9px;");
    wrap.appendChild(metaBadge());
    const body = el("div", "font-size:13.5px;line-height:1.6;color:#c9c9d0;display:flex;flex-direction:column;gap:10px;");
    for (const b of blocks) {
      if (b.t === "md") body.appendChild(el("div", "", renderMarkdown(b.text)));
      else if (b.t === "tool") {
        const c = el("div", "", renderToolCard(b.name, b.detail)).firstElementChild;
        if (c) body.appendChild(c);
      } else if (b.t === "diff") {
        const c = el("div", "", renderDiff(b.file, b.hunks)).firstElementChild;
        if (c) body.appendChild(c);
      }
    }
    wrap.appendChild(body);
    thread.appendChild(wrap);
    msgCount++;
    updateEmpty();
    scrollThread();
  }

  // -------------------------------------------------------------------------
  // Picker bottom sheet
  // -------------------------------------------------------------------------
  function openPicker(type: "harness" | "agent" | "effort"): void {
    picker = type;
    renderPicker();
    pickerBackdrop.style.display = "block";
    pickerSheet.style.display = "flex";
    pickerSheet.style.animation = "pcr-sheet .28s cubic-bezier(.2,.8,.2,1)";
  }

  function closePicker(): void {
    picker = null;
    pickerBackdrop.style.display = "none";
    pickerSheet.style.display = "none";
  }

  function renderPicker(): void {
    const c = cfg();
    pickerList.textContent = "";
    let title = "";
    let options: { label: string; sub: string; dot: HTMLElement | null; selected: boolean; onClick: () => void }[] = [];
    if (picker === "harness") {
      title = "HARNESS";
      options = harnesses.map((h) => ({
        label: h.label,
        sub: h.detected ? `${h.models.length} model${h.models.length === 1 ? "" : "s"}` : "not installed",
        dot: avatar(h, 26),
        selected: c.harnessId === h.id,
        onClick: () => choose("harness", h.id),
      }));
    } else if (picker === "agent") {
      const info = harnessInfo(c.harnessId);
      title = `${info.label.toUpperCase()} MODELS`;
      options = info.models.map((m) => ({
        label: m.label,
        sub: "",
        dot: avatar(info, 22),
        selected: c.model === m.id,
        onClick: () => choose("agent", m.id),
      }));
    } else {
      title = "EFFORT";
      options = efforts.map((e) => ({
        label: e,
        sub: EFFORT_DESC[e] ?? "",
        dot: null,
        selected: c.effort === e,
        onClick: () => choose("effort", e),
      }));
    }
    pickerTitle.textContent = title;
    for (const o of options) {
      const btn = el(
        "button",
        "width:100%;display:flex;align-items:center;gap:12px;background:none;border:none;border-radius:10px;padding:13px 12px;cursor:pointer;color:#ededf0;text-align:left;",
      );
      btn.className = "crow";
      if (o.dot) btn.appendChild(o.dot);
      const mid = el("div", "flex:1;min-width:0;");
      mid.append(el("div", "font-size:14px;font-weight:500;", o.label));
      if (o.sub) mid.appendChild(el("div", "font-size:12px;color:#77777e;margin-top:2px;", o.sub));
      btn.appendChild(mid);
      if (o.selected) btn.appendChild(el("span", `color:${ACCENT};display:flex;`, SVG.check));
      btn.onclick = o.onClick;
      pickerList.appendChild(btn);
    }
  }

  function choose(type: "harness" | "agent" | "effort", val: string): void {
    if (type === "harness") {
      const info = harnessInfo(val);
      const patch: Partial<{ harnessId: string; model: string; effort: string }> = { harnessId: val };
      if (!info.models.some((m) => m.id === cfg().model)) patch.model = info.defaultModel;
      updateCfg(patch);
    } else if (type === "agent") {
      updateCfg({ model: val });
    } else {
      updateCfg({ effort: val });
    }
    closePicker();
  }

  // -------------------------------------------------------------------------
  // Element selection (multi-select)
  // -------------------------------------------------------------------------
  function updateFades(): void {
    const n = chipsScroll;
    fadeL.style.display = n.scrollLeft > 2 ? "block" : "none";
    fadeR.style.display = n.scrollLeft + n.clientWidth < n.scrollWidth - 2 ? "block" : "none";
  }

  function renderTray(): void {
    const has = selections.length > 0;
    chipsWrap.style.display = has ? "block" : "none";
    noEls.style.display = has ? "none" : "block";
    updateFades();
  }

  function onMouseMove(e: MouseEvent): void {
    if (!selecting) return;
    const t = e.target;
    if (!(t instanceof HTMLElement) || panel.contains(t) || container.contains(t)) {
      hoverBox.style.display = "none";
      return;
    }
    place(hoverBox, t);
    hoverBox.style.display = "block";
  }

  function onClick(e: MouseEvent): void {
    if (!selecting) return;
    const t = e.target;
    if (!(t instanceof HTMLElement) || panel.contains(t) || container.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSelect(t);
  }

  function place(box: HTMLElement, node: HTMLElement): void {
    const r = node.getBoundingClientRect();
    box.style.top = `${r.top}px`;
    box.style.left = `${r.left}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  }

  function toggleSelect(node: HTMLElement): void {
    const existing = selections.find((s) => s.domEl === node);
    if (existing) {
      removeSelection(existing);
      return;
    }
    const box = el("div", "");
    box.className = "pcr-sel";
    container.appendChild(box);
    const chip = el(
      "span",
      `flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;background:rgba(236,30,99,0.14);border:1px solid rgba(236,30,99,0.4);color:#f7a8c4;border-radius:7px;padding:4px 8px;font-size:12px;font-family:${MONO};white-space:nowrap;`,
    );
    const label = el("span", "", "");
    label.textContent = breadcrumb(node);
    const x = el("button", "background:none;border:none;color:#f7a8c4;cursor:pointer;padding:0;display:flex;", SVG.x);
    const sel: Selection = { domEl: node, source: resolveSource(node), domContext: buildDomContext(node), box, chip };
    x.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeSelection(sel);
    };
    chip.append(label, x);
    chipsScroll.appendChild(chip);
    selections.push(sel);
    place(box, node);
    renderTray();
  }

  function removeSelection(sel: Selection): void {
    const i = selections.indexOf(sel);
    if (i >= 0) selections.splice(i, 1);
    sel.box.remove();
    sel.chip.remove();
    renderTray();
  }

  function reposition(): void {
    for (const s of selections) place(s.box, s.domEl);
  }

  function resolveSource(node: HTMLElement): SourceLocation | null {
    let cur: HTMLElement | null = node;
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

  function buildDomContext(node: HTMLElement): DomContext {
    const rawText = (node.textContent ?? "").trim().replace(/\s+/g, " ");
    const text = rawText.length > 0 ? rawText.slice(0, 80) : null;
    const ancestry: string[] = [];
    let cur: HTMLElement | null = node;
    while (cur && ancestry.length < 5) {
      ancestry.push(breadcrumb(cur));
      cur = cur.parentElement;
    }
    return { tag: node.tagName.toLowerCase(), id: node.id || null, classes: Array.from(node.classList), text, ancestry };
  }

  function breadcrumb(node: HTMLElement): string {
    let s = `<${node.tagName.toLowerCase()}`;
    if (node.id) s += `#${node.id}`;
    const cls = Array.from(node.classList);
    if (cls.length) s += "." + cls.join(".");
    return s + ">";
  }

  // -------------------------------------------------------------------------
  // Views / panel / compose
  // -------------------------------------------------------------------------
  let prevMargin = "";
  let prevTransition = "";

  function setPanelOpen(open: boolean): void {
    if (open === panelOpen) return;
    panelOpen = open;
    const root = document.documentElement;
    if (open) {
      prevMargin = root.style.marginRight;
      prevTransition = root.style.transition;
      root.style.transition = "margin-right 0.5s cubic-bezier(.32,.72,0,1)";
      root.style.marginRight = `${window.innerWidth < 600 ? 0 : PANEL_W + GAP * 2}px`;
      panel.classList.add("pcr-open");
      renderCmdBar();
      showList();
      send({ v: PROTOCOL_VERSION, type: "list_conversations" });
    } else {
      setSelecting(false);
      closePicker();
      panel.classList.remove("pcr-open");
      root.style.marginRight = prevMargin;
      root.style.transition = prevTransition;
    }
    updateBadge();
  }

  function showList(): void {
    view = "list";
    backBtn.style.display = "none";
    listScroll.style.display = "block";
    chatWrap.style.display = "none";
    textarea.placeholder = "Describe a change to start a new chat…";
    acceptBtn.style.display = "none";
    discardBtn.style.display = "none";
    renderList();
    renderCmdBar();
  }

  function showChat(): void {
    view = "chat";
    backBtn.style.display = "flex";
    listScroll.style.display = "none";
    chatWrap.style.display = "flex";
    textarea.placeholder = "Describe the change… (⌘/Ctrl+Enter to send)";
    const hasMsgs = msgCount > 0;
    acceptBtn.style.display = hasMsgs ? "block" : "none";
    discardBtn.style.display = hasMsgs ? "block" : "none";
    updateEmpty();
    renderCmdBar();
    setTimeout(() => textarea.focus(), 260);
  }

  function setSelecting(on: boolean): void {
    selecting = on;
    addBtn.style.background = on ? ACCENT : "#1c1c1f";
    addBtn.style.color = "#fff";
    if (!on) {
      addBtn.style.color = "#ededf0";
      hoverBox.style.display = "none";
    }
    updateBadge();
  }

  function updateBadge(): void {
    badge.style.display = selecting && panelOpen ? "block" : "none";
  }

  function setTurnRunning(r: boolean): void {
    turnRunning = r;
    sendBtn.textContent = r ? "Stop" : "Send";
    sendBtn.style.background = r ? "#3a3a3e" : ACCENT;
  }

  function submit(): void {
    if (turnRunning) return;
    const text = textarea.value.trim();
    if (!text) return;
    const elements: PromptElement[] = selections.map((s) => ({ source: s.source, domContext: s.domContext }));
    const primary = elements[0] ?? {
      source: null,
      domContext: { tag: "page", id: null, classes: [], text: null, ancestry: [] },
    };
    const payload = { prompt: text, source: primary.source, domContext: primary.domContext, elements };
    textarea.value = "";
    // consume selections into this prompt
    for (const s of [...selections]) removeSelection(s);
    if (view === "chat" && conversationId) {
      send({ v: PROTOCOL_VERSION, type: "prompt", conversationId, ...payload });
      addUserMessage(text, elements.length);
      showChat();
    } else {
      pendingPrompt = payload;
      send({ v: PROTOCOL_VERSION, type: "new_conversation", ...draft });
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  function onKeyDown(e: KeyboardEvent): void {
    if (matchesToggle(e)) {
      e.preventDefault();
      setPanelOpen(!panelOpen);
      return;
    }
    if (e.key === "Escape") {
      if (picker) closePicker();
      else if (selecting) setSelecting(false);
      else if (view === "chat" && panelOpen) showList();
      else if (panelOpen) setPanelOpen(false);
    }
  }

  function matchesToggle(e: KeyboardEvent): boolean {
    if (toggle.alt && !e.altKey) return false;
    if (toggle.ctrl && !e.ctrlKey) return false;
    if (toggle.shift && !e.shiftKey) return false;
    if (toggle.meta && !e.metaKey) return false;
    return (toggle.code !== null && e.code === toggle.code) || e.key.toLowerCase() === toggle.key;
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition, true);

  renderCmdBar();
  renderTray();
  console.info(`[pincer] overlay ready — press ${config.toggleKey ?? "Alt+P"} to open`);
  connect();
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
