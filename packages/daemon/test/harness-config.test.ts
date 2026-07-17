import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { PROTOCOL_VERSION } from "@pincer/core";
import { createHarness, FAKE_OMP, type Harness } from "./harness";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const V = PROTOCOL_VERSION;
let h: Harness | undefined;
setDefaultTimeout(30_000);

afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function omp(): Promise<Harness> {
  const harness = await createHarness({ agentId: "omp", agentCommand: ["bun", FAKE_OMP] });
  await harness.next("welcome");
  return harness;
}

test("welcome advertises detected harnesses, efforts, and dynamic models", async () => {
  h = await createHarness({ agentId: "omp", agentCommand: ["bun", FAKE_OMP] });
  const w = await h.next("welcome");
  expect(w.defaultHarnessId).toBe("omp");
  expect(w.efforts).toContain("High");
  const ompH = w.harnesses.find((x) => x.id === "omp");
  expect(ompH?.detected).toBe(true);
  // Models come from `omp models --json` (fake-omp catalog), Default first.
  expect(ompH?.models[0]).toEqual({ id: "", label: "Default" });
  // Reasoning model carries its per-model thinking levels.
  expect(ompH?.models).toContainEqual({
    id: "anthropic/claude-opus-4-8",
    label: "Claude Opus 4.8",
    efforts: ["low", "medium", "high", "max"],
  });
  // Non-reasoning model (thinking: null) has no per-model efforts.
  expect(ompH?.models).toContainEqual({ id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" });
});

test("conversation config drives the model + effort CLI flags", async () => {
  h = await omp();
  h.send({ v: V, type: "new_conversation", harnessId: "omp", model: "opus", effort: "Low" });
  const started = await h.next("conversation_started");
  expect(started.conversation.harnessId).toBe("omp");
  expect(started.conversation.model).toBe("opus");
  expect(started.conversation.effort).toBe("Low");

  h.send({
    v: V,
    type: "prompt",
    conversationId: started.conversation.id,
    prompt: h.userPrompt,
    source: h.source,
    domContext: h.domContext,
  });
  await h.next("turn_started");
  await h.next("turn_complete");

  // fixture records the launch argv as { argv: string[] }
  const record = JSON.parse(h.readRecord()) as { argv: string[] };
  const argv = record.argv;
  expect(argv).toContain("--model");
  expect(argv).toContain("opus");
  expect(argv).toContain("--thinking");
  expect(argv).toContain("low");
});

test("set_config updates a conversation's command-bar selection", async () => {
  h = await omp();
  h.send({ v: V, type: "new_conversation", harnessId: "omp", model: "", effort: "High" });
  const started = await h.next("conversation_started");
  h.send({ v: V, type: "set_config", conversationId: started.conversation.id, effort: "Max", model: "sonnet" });
  const updated = await h.next("config_updated");
  expect(updated.conversation.effort).toBe("Max");
  expect(updated.conversation.model).toBe("sonnet");
});

test("delete_conversation removes it from the list", async () => {
  h = await omp();
  h.send({ v: V, type: "new_conversation" });
  const started = await h.next("conversation_started");
  h.send({ v: V, type: "delete_conversation", conversationId: started.conversation.id });
  const deleted = await h.next("deleted");
  expect(deleted.conversationId).toBe(started.conversation.id);

  h.send({ v: V, type: "list_conversations" });
  const list = await h.next("conversations");
  expect(list.items.find((c) => c.id === started.conversation.id)).toBeUndefined();
});

test("a turn streams only the diff of files it changed this turn", async () => {
  h = await omp();
  // Pre-existing dirt in a tracked file (mirrors the monorepo's own edits).
  appendFileSync(join(h.dir, ".gitignore"), "\n# pre-existing dirt\n");
  h.send({ v: V, type: "new_conversation" });
  const started = await h.next("conversation_started");
  h.send({
    v: V,
    type: "prompt",
    conversationId: started.conversation.id,
    prompt: h.userPrompt,
    source: h.source,
    domContext: h.domContext,
  });
  const diffs: { file: string; hunks: { type: string; text: string }[] }[] = [];
  for (;;) {
    const m = await h.nextWhere(
      (x) => (x.type === "agent_output" && x.event.kind === "diff") || x.type === "turn_complete",
    );
    if (m.type === "turn_complete") break;
    if (m.type === "agent_output" && m.event.kind === "diff") diffs.push({ file: m.event.file, hunks: m.event.hunks });
  }
  expect(diffs.some((d) => d.file.includes("App.tsx"))).toBe(true);
  expect(diffs.some((d) => d.file.includes(".gitignore"))).toBe(false);
  const app = diffs.find((d) => d.file.includes("App.tsx"));
  expect(app?.hunks.some((hh) => hh.type === "add" && hh.text.includes("PINCER_EDIT_MARKER"))).toBe(true);
});

test("resuming a conversation replays persisted md + diff blocks", async () => {
  h = await omp();
  h.send({ v: V, type: "new_conversation" });
  const started = await h.next("conversation_started");
  h.send({
    v: V,
    type: "prompt",
    conversationId: started.conversation.id,
    prompt: h.userPrompt,
    source: h.source,
    domContext: h.domContext,
  });
  await h.next("turn_complete");

  h.send({ v: V, type: "resume_conversation", conversationId: started.conversation.id });
  const resumed = await h.next("conversation_resumed");
  const turn = resumed.turns[0];
  if (!turn) throw new Error("no turn replayed");
  expect(turn.blocks.some((b) => b.t === "diff")).toBe(true);
  expect(turn.blocks.some((b) => b.t === "md")).toBe(true);
});
