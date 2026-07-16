import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@pincer/core";
import { createHarness, FAKE_CLAUDE_SLOW, type Harness } from "./harness";

const V = PROTOCOL_VERSION;
let h: Harness | undefined;

setDefaultTimeout(30_000);

afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function startConversation(harness: Harness): Promise<string> {
  harness.send({ v: V, type: "new_conversation" });
  const started = await harness.next("conversation_started");
  return started.conversation.id;
}

async function runTurn(harness: Harness, convId: string, prompt: string): Promise<void> {
  harness.send({
    v: V,
    type: "prompt",
    conversationId: convId,
    prompt,
    source: harness.source,
    domContext: harness.domContext,
  });
  await harness.next("turn_started");
  await harness.next("turn_complete");
}

function lastTurnRow(harness: Harness, convId: string): Record<string, unknown> {
  const db = new Database(join(harness.dir, ".pincer/history.db"));
  try {
    const row = db
      .query("SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1")
      .get(convId);
    if (!row || typeof row !== "object") throw new Error("no turn row found");
    return row as Record<string, unknown>;
  } finally {
    db.close();
  }
}

test("happy turn edits the file in place and records the turn", async () => {
  h = await createHarness();
  const convId = await startConversation(h);
  expect(h.gitOut(["branch"])).not.toContain("pincer/");

  h.send({
    v: V,
    type: "prompt",
    conversationId: convId,
    prompt: h.userPrompt,
    source: h.source,
    domContext: h.domContext,
  });
  await h.next("turn_started");
  const textEvent = await h.nextWhere((m) => m.type === "agent_output" && m.event.kind === "text");
  expect(textEvent.type).toBe("agent_output");

  const complete = await h.next("turn_complete");
  expect(complete.success).toBe(true);
  expect(complete.checkpoint).toBeNull();

  expect(h.readTarget()).toContain("PINCER_EDIT_MARKER");
  const record = h.readRecord();
  expect(record).toContain("src/App.tsx");
  expect(record).toContain(h.userPrompt);

  const turn = lastTurnRow(h, convId);
  expect(turn["checkpoint"]).toBeNull();
  expect(turn["agent_session_id"]).toBe("sess-1");
});

test("revert is unavailable in direct-edit mode", async () => {
  h = await createHarness();
  const convId = await startConversation(h);
  await runTurn(h, convId, h.userPrompt);
  expect(h.readTarget()).toContain("PINCER_EDIT_MARKER");

  h.send({ v: V, type: "revert", conversationId: convId });
  const err = await h.next("error");
  expect(err.message).toContain("direct-edit");
  expect(h.readTarget()).toContain("PINCER_EDIT_MARKER");
});

test("accept closes the conversation without touching git", async () => {
  h = await createHarness();
  const headBefore = h.gitOut(["rev-parse", "HEAD"]).trim();
  const convId = await startConversation(h);
  await runTurn(h, convId, h.userPrompt);
  expect(h.readTarget()).toContain("PINCER_EDIT_MARKER");

  h.send({ v: V, type: "accept", conversationId: convId });
  const accepted = await h.next("accepted");
  expect(accepted.conversationId).toBe(convId);
  expect(h.gitOut(["branch"])).not.toContain("pincer/");
  expect(h.gitOut(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
  expect(h.readTarget()).toContain("PINCER_EDIT_MARKER");
});

test("discard closes the conversation and leaves the working tree edit intact", async () => {
  h = await createHarness();
  const convId = await startConversation(h);
  await runTurn(h, convId, h.userPrompt);
  expect(h.readTarget()).toContain("PINCER_EDIT_MARKER");

  h.send({ v: V, type: "discard", conversationId: convId });
  await h.next("discarded");
  expect(h.gitOut(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  expect(h.gitOut(["branch"])).not.toContain("pincer/");
  expect(h.readTarget()).toContain("PINCER_EDIT_MARKER");
});

test("new_conversation succeeds even with a dirty working tree", async () => {
  h = await createHarness();
  h.dirtyTarget();

  h.send({ v: V, type: "new_conversation" });
  const started = await h.next("conversation_started");
  expect(started.conversation.id).toBeTruthy();
  expect(started.conversation.branch).not.toContain("pincer/");
});

test("no detected agent yields welcome{defaultHarnessId:null} and blocks prompts", async () => {
  h = await createHarness({ agentCommand: ["definitely-not-a-binary-xyz"], agentId: "claude-code" });
  const welcome = await h.next("welcome");
  expect(welcome.defaultHarnessId).toBeNull();

  const convId = await startConversation(h);
  h.send({ v: V, type: "prompt", conversationId: convId, prompt: "x", source: null, domContext: h.domContext });
  const blocked = await h.next("blocked");
  expect(blocked.reason).toBe("no_agent");
});

test("cancel kills the running turn and leaves the file unchanged", async () => {
  h = await createHarness({ agentCommand: ["bun", FAKE_CLAUDE_SLOW] });
  const convId = await startConversation(h);
  h.send({
    v: V,
    type: "prompt",
    conversationId: convId,
    prompt: h.userPrompt,
    source: h.source,
    domContext: h.domContext,
  });
  await h.next("turn_started");

  h.send({ v: V, type: "cancel", conversationId: convId });
  const done = await h.nextWhere((m) => m.type === "turn_complete" || m.type === "turn_error");
  if (done.type === "turn_complete") expect(done.success).toBe(false);

  expect(h.readTarget()).not.toContain("PINCER_EDIT_MARKER");
  const turn = lastTurnRow(h, convId);
  expect(turn["status"]).toBe("cancelled");
});

test("a second turn resumes the prior agent session", async () => {
  h = await createHarness();
  const convId = await startConversation(h);
  await runTurn(h, convId, "first change");
  await runTurn(h, convId, "second change");

  const record = h.readRecord();
  expect(record).toContain("--resume");
  expect(record).toContain("sess-1");
});

test("history survives a daemon restart", async () => {
  h = await createHarness();
  const convId = await startConversation(h);
  await runTurn(h, convId, h.userPrompt);

  await h.restart();
  h.send({ v: V, type: "list_conversations" });
  const list = await h.next("conversations");
  const found = list.items.find((c) => c.id === convId);
  expect(found).toBeDefined();
  expect(found?.turnCount).toBe(1);
});
