import { expect, test } from "bun:test";
import { DEFAULT_TOGGLE_SHORTCUT, PROTOCOL_VERSION } from "@pincer/core";
import type { ClientMessage, ServerMessage } from "@pincer/core";
import { usePincerStore } from "../src/state/store";

/** Reset the shared singleton's thread slices so each test is order-independent. */
function resetThread(): void {
  usePincerStore.setState({
    messages: [],
    streamingIndex: null,
    turnRunning: false,
    view: "list",
    conversationId: null,
    connected: false,
    panelOpen: false,
    selecting: false,
    picker: null,
    shortcut: DEFAULT_TOGGLE_SHORTCUT,
    showFloatingButton: true,
    appRoot: null,
    appOrigin: null,
    settingsLoaded: false,
    settingsPending: false,
    settingsError: null,
    recordingShortcut: false,
    send: () => {},
  });
}

const welcome: ServerMessage = {
  v: PROTOCOL_VERSION,
  type: "welcome",
  daemonVersion: "t",
  protocolVersion: PROTOCOL_VERSION,
  projectRoot: "/x",
  harnesses: [],
  efforts: [],
  defaultHarnessId: null,
};

const apply = (msg: ServerMessage): void => usePincerStore.getState().applyServerMessage(msg);

test("streaming text deltas coalesce into one assistant md block and turn_complete clears run flag", () => {
  resetThread();
  apply(welcome);
  apply({ v: PROTOCOL_VERSION, type: "turn_started", conversationId: "c1", turnId: 1, seq: 0 });
  apply({ v: PROTOCOL_VERSION, type: "agent_output", conversationId: "c1", turnId: 1, event: { kind: "text", text: "foo" } });
  apply({ v: PROTOCOL_VERSION, type: "agent_output", conversationId: "c1", turnId: 1, event: { kind: "text", text: "bar" } });
  apply({ v: PROTOCOL_VERSION, type: "turn_complete", conversationId: "c1", turnId: 1, checkpoint: null, success: true, summary: "" });

  const s = usePincerStore.getState();
  expect(s.messages.length).toBe(1);
  const m = s.messages[0];
  if (!m) throw new Error("expected an assistant message");
  expect(m.role).toBe("assistant");
  expect(m.blocks).toEqual([{ t: "md", text: "foobar" }]);
  expect(s.turnRunning).toBe(false);
});

test("after the stream pointer clears, tool then diff events open a new assistant message with blocks in order", () => {
  resetThread();
  apply(welcome);
  apply({ v: PROTOCOL_VERSION, type: "turn_started", conversationId: "c1", turnId: 1, seq: 0 });
  apply({ v: PROTOCOL_VERSION, type: "agent_output", conversationId: "c1", turnId: 1, event: { kind: "text", text: "foo" } });
  apply({ v: PROTOCOL_VERSION, type: "agent_output", conversationId: "c1", turnId: 1, event: { kind: "text", text: "bar" } });
  apply({ v: PROTOCOL_VERSION, type: "turn_complete", conversationId: "c1", turnId: 1, checkpoint: null, success: true, summary: "" });

  apply({ v: PROTOCOL_VERSION, type: "agent_output", conversationId: "c1", turnId: 1, event: { kind: "tool", name: "Edit", detail: "a.ts" } });
  apply({ v: PROTOCOL_VERSION, type: "agent_output", conversationId: "c1", turnId: 1, event: { kind: "diff", file: "a.ts", hunks: [{ type: "add", text: "x" }] } });

  const s = usePincerStore.getState();
  const last = s.messages[s.messages.length - 1];
  if (!last) throw new Error("expected an assistant message");
  expect(last.role).toBe("assistant");
  expect(last.blocks).toEqual([
    { t: "tool", name: "Edit", detail: "a.ts" },
    { t: "diff", file: "a.ts", hunks: [{ type: "add", text: "x" }] },
  ]);
});

test("settings changes apply only after the daemon acknowledgement", () => {
  resetThread();
  const sent: ClientMessage[] = [];
  usePincerStore.setState({ connected: true, send: (message) => sent.push(message) });
  usePincerStore.getState().prepareSettings("/app", "http://localhost:5173", null);
  apply({
    v: PROTOCOL_VERSION,
    type: "overlay_settings",
    settings: {
      appRoot: "/app",
      appOrigin: "http://localhost:5173",
      shortcut: DEFAULT_TOGGLE_SHORTCUT,
      showFloatingButton: true,
    },
  });
  const updatedShortcut = { code: "KeyK", alt: false, ctrl: true, shift: true, meta: false };

  usePincerStore.getState().updateShortcut(updatedShortcut);

  expect(usePincerStore.getState().shortcut).toEqual(DEFAULT_TOGGLE_SHORTCUT);
  expect(usePincerStore.getState().settingsPending).toBe(true);
  expect(sent).toEqual([
    {
      v: PROTOCOL_VERSION,
      type: "update_overlay_settings",
      appRoot: "/app",
      appOrigin: "http://localhost:5173",
      shortcut: updatedShortcut,
    },
  ]);

  apply({
    v: PROTOCOL_VERSION,
    type: "overlay_settings",
    settings: {
      appRoot: "/canonical/app",
      appOrigin: "http://localhost:5173",
      shortcut: updatedShortcut,
      showFloatingButton: true,
    },
  });
  expect(usePincerStore.getState().shortcut).toEqual(updatedShortcut);
  expect(usePincerStore.getState().appRoot).toBe("/canonical/app");
  expect(usePincerStore.getState().settingsPending).toBe(false);
});

test("settings acknowledgements from a stale origin are ignored", () => {
  resetThread();
  usePincerStore.setState({
    appRoot: "/app",
    appOrigin: "http://localhost:5173",
    settingsLoaded: true,
  });

  apply({
    v: PROTOCOL_VERSION,
    type: "overlay_settings",
    settings: {
      appRoot: "/app",
      appOrigin: "http://localhost:5174",
      shortcut: { code: "KeyK", alt: false, ctrl: true, shift: true, meta: false },
      showFloatingButton: false,
    },
  });

  expect(usePincerStore.getState().shortcut).toEqual(DEFAULT_TOGGLE_SHORTCUT);
  expect(usePincerStore.getState().showFloatingButton).toBe(true);
  expect(usePincerStore.getState().appOrigin).toBe("http://localhost:5173");
});

test("opening settings atomically clears transient conversation interactions", () => {
  resetThread();
  usePincerStore.setState({
    view: "chat",
    picker: "harness",
    selecting: true,
    recordingShortcut: true,
  });

  usePincerStore.getState().openSettings();

  expect(usePincerStore.getState()).toMatchObject({
    view: "settings",
    picker: null,
    selecting: false,
    recordingShortcut: false,
  });
});

test("settings failures preserve acknowledged values and expose the error", () => {
  resetThread();
  const shortcut = { code: "KeyK", alt: false, ctrl: true, shift: true, meta: false };
  usePincerStore.setState({ connected: true, send: () => {} });
  usePincerStore.getState().prepareSettings("/app", "http://localhost:5173", null);
  apply({
    v: PROTOCOL_VERSION,
    type: "overlay_settings",
    settings: {
      appRoot: "/app",
      appOrigin: "http://localhost:5173",
      shortcut,
      showFloatingButton: false,
    },
  });
  usePincerStore.getState().updateShowFloatingButton(true);

  apply({
    v: PROTOCOL_VERSION,
    type: "error",
    code: "settings_unavailable",
    message: "Pincer settings are unavailable.",
  });

  expect(usePincerStore.getState()).toMatchObject({
    shortcut,
    showFloatingButton: false,
    settingsPending: false,
    settingsError: "Pincer settings are unavailable.",
  });
});
