import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@pincer/core";
import { createHarness, FAKE_OMP, type Harness } from "./harness";

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
  const db = new Database(harness.historyDbPath);
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

test("omp happy turn edits the file in place and captures the session id", async () => {
  h = await createHarness({ agentId: "omp", agentCommand: ["bun", FAKE_OMP] });
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

  const complete = await h.next("turn_complete");
  expect(complete.success).toBe(true);
  expect(complete.checkpoint).toBeNull();

  expect(h.readTarget()).toContain("PINCER_EDIT_MARKER");

  const record = JSON.parse(h.readRecord()) as { argv: string[] };
  const argv = record.argv;
  expect(argv).toContain("-p");
  expect(argv).toContain("--mode");
  expect(argv).toContain("json");
  expect(argv).toContain("--auto-approve");
  expect(argv).toContain("--session-dir");
  const sessionDirIndex = argv.indexOf("--session-dir");
  expect(argv[sessionDirIndex + 1]).toBe(join(h.pincerDataDir, "omp-sessions"));
  expect(argv).not.toContain("-r");
  // Source path and user prompt live inside the trailing composed positional arg.
  const composed = argv[argv.length - 1] ?? "";
  expect(composed).toContain("src/App.tsx");
  expect(composed).toContain(h.userPrompt);

  const turn = lastTurnRow(h, convId);
  expect(turn.agent_session_id).toBe("omp-sess-1");
});

test("omp resume uses -r with the captured session id on the second turn", async () => {
  h = await createHarness({ agentId: "omp", agentCommand: ["bun", FAKE_OMP] });
  const convId = await startConversation(h);
  await runTurn(h, convId, "first change");
  await runTurn(h, convId, "second change");

  const record2 = JSON.parse(h.readRecord()) as { argv: string[] };
  const argv = record2.argv;
  expect(argv).toContain("-r");
  expect(argv).toContain("omp-sess-1");
});
