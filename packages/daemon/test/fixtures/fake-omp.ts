#!/usr/bin/env bun
// Stand-in for the omp (Oh My Pi) CLI at the process boundary. Emits real
// omp-format JSONL events so the production adapter parser is exercised, records
// the argv it was invoked with, and applies a scripted file edit.
export {};

// `detect` probes with `--version` — a real CLI has no side effects here.
if (Bun.argv.includes("--version")) {
  process.stdout.write("omp/0.0.0-fake\n");
  process.exit(0);
}

const argv = Bun.argv.slice(2);

// `listModels` probes with `models --json`: return a fixed catalog and exit
// before any turn/edit side effects.
if (argv[0] === "models" && argv.includes("--json")) {
  process.stdout.write(
    JSON.stringify({
      models: [
        { provider: "anthropic", id: "claude-opus-4-8", selector: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", thinking: ["low", "medium", "high", "max"] },
        { provider: "anthropic", id: "claude-sonnet-5", selector: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", thinking: null },
      ],
    }),
  );
  process.exit(0);
}

const record = process.env.PINCER_FAKE_RECORD;
if (record) await Bun.write(record, JSON.stringify({ argv }, null, 2));

const emit = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

emit({ type: "session", version: 3, id: "omp-sess-1" });
emit({ type: "agent_start" });
emit({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: "Applying your change…" },
});

const target = process.env.PINCER_FAKE_TARGET;
const append = process.env.PINCER_FAKE_APPEND ?? "";
if (target) {
  const current = await Bun.file(target).text();
  await Bun.write(target, current + append);
}

emit({ type: "agent_end", messages: [] });
process.exit(0);
