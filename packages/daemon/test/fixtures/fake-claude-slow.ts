#!/usr/bin/env bun
// Like fake-claude, but sleeps *before* applying its edit and emitting the
// result, so a cancel arrives mid-flight: no file change, no result event.
export {};

// `detect` probes with `--version` — a real CLI has no side effects here.
if (Bun.argv.includes("--version")) {
  process.stdout.write("pincer-fake-claude 0.0.0\n");
  process.exit(0);
}

const argv = Bun.argv.slice(2);

const record = process.env["PINCER_FAKE_RECORD"];
if (record) await Bun.write(record, JSON.stringify({ argv }, null, 2));

const emit = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};

emit({ type: "system", subtype: "init", session_id: "sess-1", model: "fake" });
emit({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "Thinking…" } },
});

await Bun.sleep(10_000);

// Only reached if never cancelled.
const target = process.env["PINCER_FAKE_TARGET"];
const append = process.env["PINCER_FAKE_APPEND"] ?? "";
if (target) {
  const current = await Bun.file(target).text();
  await Bun.write(target, current + append);
}
emit({ type: "result", is_error: false, session_id: "sess-1", result: "done" });
process.exit(0);
