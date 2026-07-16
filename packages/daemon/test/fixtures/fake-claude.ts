#!/usr/bin/env bun
// Stand-in for the Claude Code CLI at the process boundary. Emits real
// stream-json lines so the production adapter parser is exercised, records the
// argv it was invoked with, and applies a scripted file edit.
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
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "Applying your change…" } },
});

const target = process.env["PINCER_FAKE_TARGET"];
const append = process.env["PINCER_FAKE_APPEND"] ?? "";
if (target) {
  const current = await Bun.file(target).text();
  await Bun.write(target, current + append);
}

emit({ type: "result", is_error: false, session_id: "sess-1", result: "done" });
process.exit(0);
