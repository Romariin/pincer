import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { PROTOCOL_VERSION } from "@pincer/core";
import type {
  ClientMessage,
  ServerMessage,
  ConversationSummary,
  DomContext,
  HarnessAvailability,
  HarnessInfo,
  MessageBlock,
  PromptElement,
  SourceLocation,
} from "@pincer/core";
import { clampEffort, harnessInfo, modelEfforts } from "@/lib/harness";
import { buildDomContext, resolveSource } from "@/dom/picker";

export type View = "list" | "chat";
export type PickerKind = "harness" | "agent" | "effort";

export interface Cfg {
  harnessId: string;
  model: string;
  effort: string;
}

export interface Msg {
  role: "user" | "assistant" | "system";
  blocks: MessageBlock[];
  /** Command-bar config captured when an assistant turn began (drives the meta badge). */
  meta?: Cfg;
  /** Number of elements attached to a user prompt (drives the chip count label). */
  elementCount?: number;
}

export interface Selection {
  domEl: HTMLElement;
  source: SourceLocation | null;
  domContext: DomContext;
}

export interface PendingPrompt {
  prompt: string;
  source: SourceLocation | null;
  domContext: DomContext;
  elements: PromptElement[];
}

const DEFAULT_EFFORTS = ["Minimal", "Low", "Medium", "High", "Max"];

export interface PincerStore {
  // ---- connection / view ----
  connected: boolean;
  view: View;
  panelOpen: boolean;
  selecting: boolean;
  turnRunning: boolean;
  picker: PickerKind | null;

  // ---- harness catalog ----
  harnesses: HarnessAvailability[];
  efforts: string[];
  harnessMap: Record<string, HarnessInfo>;
  draft: Cfg;

  // ---- conversations / thread ----
  conversations: ConversationSummary[];
  conversationId: string | null;
  messages: Msg[];
  /** Index of the assistant message currently receiving stream output (mirrors the old curBody ref). */
  streamingIndex: number | null;
  pendingPrompt: PendingPrompt | null;

  // ---- element selections ----
  selections: Selection[];

  // ---- socket ----
  send: (msg: ClientMessage) => void;
  setSend: (fn: (msg: ClientMessage) => void) => void;
  setConnected: (c: boolean) => void;

  // ---- UI ops ----
  setPanelOpen: (open: boolean) => void;
  setView: (view: View) => void;
  openPicker: (kind: PickerKind) => void;
  closePicker: () => void;
  setSelecting: (on: boolean) => void;
  setTurnRunning: (r: boolean) => void;

  // ---- config ----
  updateCfg: (patch: Partial<Cfg>) => void;
  choose: (kind: PickerKind, val: string) => void;

  // ---- selections ----
  toggleSelect: (node: HTMLElement) => void;
  removeSelection: (domEl: HTMLElement) => void;
  clearSelections: () => void;

  // ---- thread ----
  addUserMessage: (text: string, count: number) => void;
  setPendingPrompt: (p: PendingPrompt | null) => void;

  // ---- protocol ----
  applyServerMessage: (msg: ServerMessage) => void;
}

/** Resolve the active command-bar config: the conversation's in chat view, else the draft. */
export function computeCfg(s: PincerStore): Cfg {
  if (s.view === "chat" && s.conversationId) {
    const c = s.conversations.find((x) => x.id === s.conversationId);
    if (c) return { harnessId: c.harnessId, model: c.model, effort: c.effort };
  }
  return { ...s.draft };
}

function userMsg(text: string, count: number): Msg {
  return { role: "user", blocks: [{ t: "md", text }], elementCount: count };
}

export const usePincerStore = create<PincerStore>()((set, get) => {
  // Append delta to the streaming assistant message, coalescing into a trailing md block.
  const appendText = (delta: string): void => {
    let idx = get().streamingIndex;
    if (idx === null) {
      beginAssistant();
      idx = get().streamingIndex;
    }
    set((s) => ({
      messages: s.messages.map((m, i) => {
        if (i !== idx) return m;
        const blocks = [...m.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.t === "md") blocks[blocks.length - 1] = { t: "md", text: last.text + delta };
        else blocks.push({ t: "md", text: delta });
        return { ...m, blocks };
      }),
    }));
  };

  const addBlock = (block: MessageBlock): void => {
    let idx = get().streamingIndex;
    if (idx === null) {
      beginAssistant();
      idx = get().streamingIndex;
    }
    set((s) => ({
      messages: s.messages.map((m, i) => (i === idx ? { ...m, blocks: [...m.blocks, block] } : m)),
    }));
  };

  const beginAssistant = (): void => {
    set((s) => ({
      messages: [...s.messages, { role: "assistant", blocks: [], meta: computeCfg(s) }],
      streamingIndex: s.messages.length,
    }));
  };

  const finishAssistant = (): void => {
    set((s) => {
      const idx = s.streamingIndex;
      if (idx === null) return { streamingIndex: null };
      const cur = s.messages[idx];
      // Drop an assistant turn that produced no content (mirrors the old empty-body cleanup).
      if (cur && cur.role === "assistant" && cur.blocks.length === 0) {
        return { messages: s.messages.filter((_, i) => i !== idx), streamingIndex: null };
      }
      return { streamingIndex: null };
    });
  };

  // System note: only surfaced in chat view (mirrors the old sysNote early-return).
  const sysNote = (text: string): void => {
    if (get().view !== "chat") return;
    set((s) => ({ messages: [...s.messages, { role: "system", blocks: [{ t: "md", text }] }] }));
  };

  return {
    connected: false,
    view: "list",
    panelOpen: false,
    selecting: false,
    turnRunning: false,
    picker: null,

    harnesses: [],
    efforts: DEFAULT_EFFORTS,
    harnessMap: {},
    draft: { harnessId: "", model: "", effort: "High" },

    conversations: [],
    conversationId: null,
    messages: [],
    streamingIndex: null,
    pendingPrompt: null,

    selections: [],

    send: () => {},
    setSend: (fn) => set({ send: fn }),
    setConnected: (c) => set({ connected: c }),

    setPanelOpen: (open) => {
      if (open === get().panelOpen) return;
      if (open) {
        set({ panelOpen: true, view: "list" });
        get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
      } else {
        set({ panelOpen: false, selecting: false, picker: null });
      }
    },
    setView: (view) => set({ view }),
    openPicker: (kind) => set({ picker: kind }),
    closePicker: () => set({ picker: null }),
    setSelecting: (on) => set({ selecting: on }),
    setTurnRunning: (r) => set({ turnRunning: r }),

    updateCfg: (patch) => {
      const s = get();
      if (s.view === "chat" && s.conversationId) {
        const conversationId = s.conversationId;
        set({
          conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, ...patch } : c)),
        });
        s.send({ v: PROTOCOL_VERSION, type: "set_config", conversationId, ...patch });
      } else {
        set({ draft: { ...s.draft, ...patch } });
      }
    },

    choose: (kind, val) => {
      const s = get();
      const cur = computeCfg(s);
      if (kind === "harness") {
        const info = harnessInfo(s.harnessMap, val);
        const patch: Partial<Cfg> = { harnessId: val };
        let model = cur.model;
        if (!info.models.some((m) => m.id === model)) {
          model = info.defaultModel;
          patch.model = model;
        }
        const effort = clampEffort(modelEfforts(info, model, s.efforts), cur.effort);
        if (effort !== cur.effort) patch.effort = effort;
        s.updateCfg(patch);
      } else if (kind === "agent") {
        const info = harnessInfo(s.harnessMap, cur.harnessId);
        const patch: Partial<Cfg> = { model: val };
        const effort = clampEffort(modelEfforts(info, val, s.efforts), cur.effort);
        if (effort !== cur.effort) patch.effort = effort;
        s.updateCfg(patch);
      } else {
        s.updateCfg({ effort: val });
      }
    },

    toggleSelect: (node) => {
      const s = get();
      if (s.selections.some((sel) => sel.domEl === node)) {
        set({ selections: s.selections.filter((sel) => sel.domEl !== node) });
        return;
      }
      const sel: Selection = { domEl: node, source: resolveSource(node), domContext: buildDomContext(node) };
      set({ selections: [...s.selections, sel] });
    },
    removeSelection: (domEl) => set((s) => ({ selections: s.selections.filter((sel) => sel.domEl !== domEl) })),
    clearSelections: () => set({ selections: [] }),

    addUserMessage: (text, count) => set((s) => ({ messages: [...s.messages, userMsg(text, count)] })),
    setPendingPrompt: (p) => set({ pendingPrompt: p }),

    applyServerMessage: (msg) => {
      const s = get();
      switch (msg.type) {
        case "welcome": {
          const efforts = msg.efforts.length ? msg.efforts : s.efforts;
          const harnessMap: Record<string, HarnessInfo> = {};
          for (const h of msg.harnesses) harnessMap[h.id] = h;
          const def =
            msg.defaultHarnessId ?? msg.harnesses.find((h) => h.detected)?.id ?? msg.harnesses[0]?.id ?? "";
          const dinfo = harnessInfo(harnessMap, def);
          const model = dinfo.defaultModel;
          const effort = clampEffort(modelEfforts(dinfo, model, efforts), s.draft.effort);
          set({
            harnesses: msg.harnesses,
            efforts,
            harnessMap,
            draft: { harnessId: def, model, effort },
          });
          break;
        }
        case "conversations":
          set({ conversations: msg.items });
          break;
        case "conversation_started": {
          const id = msg.conversation.id;
          set({
            conversationId: id,
            conversations: [msg.conversation, ...s.conversations.filter((c) => c.id !== id)],
            messages: [],
            streamingIndex: null,
            view: "chat",
          });
          const pending = s.pendingPrompt;
          if (pending) {
            s.send({ v: PROTOCOL_VERSION, type: "prompt", conversationId: id, ...pending });
            set((st) => ({ messages: [...st.messages, userMsg(pending.prompt, pending.elements.length)] }));
            set({ pendingPrompt: null });
          }
          break;
        }
        case "conversation_resumed": {
          const id = msg.conversation.id;
          const cfg = computeCfg({ ...s, view: "chat", conversationId: id, conversations: [msg.conversation, ...s.conversations.filter((c) => c.id !== id)] } as PincerStore);
          const messages: Msg[] = [];
          for (const t of msg.turns) {
            messages.push(userMsg(t.prompt, 0));
            if (t.blocks.length) messages.push({ role: "assistant", blocks: t.blocks, meta: cfg });
          }
          set({
            conversationId: id,
            conversations: [msg.conversation, ...s.conversations.filter((c) => c.id !== id)],
            messages,
            streamingIndex: null,
            view: "chat",
          });
          break;
        }
        case "config_updated":
          set({
            conversations: s.conversations.map((c) => (c.id === msg.conversation.id ? msg.conversation : c)),
          });
          break;
        case "deleted":
          set({ conversations: s.conversations.filter((c) => c.id !== msg.conversationId) });
          break;
        case "blocked":
          set({ pendingPrompt: null, turnRunning: false });
          sysNote(msg.message);
          break;
        case "turn_started":
          set({ turnRunning: true });
          beginAssistant();
          break;
        case "agent_output": {
          const e = msg.event;
          if (e.kind === "text") appendText(e.text);
          else if (e.kind === "tool") addBlock({ t: "tool", name: e.name, detail: e.detail });
          else if (e.kind === "diff") addBlock({ t: "diff", file: e.file, hunks: e.hunks });
          // status events are ignored (shown only as the typing indicator).
          break;
        }
        case "turn_complete":
          finishAssistant();
          set({ turnRunning: false });
          get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
          break;
        case "turn_error":
          finishAssistant();
          set({ turnRunning: false });
          sysNote(`Error: ${msg.message}`);
          break;
        case "accepted":
        case "discarded":
          set({ conversationId: null, view: "list" });
          get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
          break;
        case "error":
          sysNote(msg.message);
          break;
      }
    },
  };
});

/** Reactive command-bar config; shallow-compared so equal values don't re-render. */
export function useCfg(): Cfg {
  return usePincerStore(useShallow(computeCfg));
}
