import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@pincer/core";
import type { ServerMessage } from "@pincer/core";
import { usePincerStore } from "../src/state/store";

/** Reset the shared singleton's thread slices so each test is order-independent. */
function resetThread(): void {
  usePincerStore.setState({
    messages: [],
    streamingIndex: null,
    turnRunning: false,
    view: "list",
    conversationId: null,
  });
}

const welcome: ServerMessage = {
  v: PROTOCOL_VERSION,
  type: "welcome",
  daemonVersion: "t",
  protocolVersion: 1,
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
  const m = s.messages[0]!;
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
  const last = s.messages[s.messages.length - 1]!;
  expect(last.role).toBe("assistant");
  expect(last.blocks).toEqual([
    { t: "tool", name: "Edit", detail: "a.ts" },
    { t: "diff", file: "a.ts", hunks: [{ type: "add", text: "x" }] },
  ]);
});
