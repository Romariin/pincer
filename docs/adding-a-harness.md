# Adding a Harness

A Harness is the daemon-side adapter for a coding CLI. Built-ins are deliberately static: they are trusted code, run with the user's project as their working directory, and translate vendor output into Pincer's shared protocol.

## 1. Implement the definition

Add `packages/daemon/src/harnesses/<id>.ts` and export a `HarnessDefinition` from `types.ts`. A definition owns only vendor behavior:

- `id`, browser-safe `display` metadata, `defaultCommand`, and `probeArgs`;
- a `catalog` command and decoder that return only models reported by the CLI;
- `buildTurn`, which returns argv and optional stdin without invoking a process;
- `decodeRecord`, which converts one parsed output record into `HarnessEvent`s.

Use argv arrays rather than shell strings. Treat model, effort, and resume-token values as opaque vendor values. Use `composePrompt(request)` for the common source, DOM, attachment, and user-prompt context. Decoders must validate unknown input and return `invalid` with a useful diagnostic rather than throwing.

The event vocabulary is intentionally small: `status`, `text`, `tool`, `session`, and terminal `result`. Git diffs are collected by the orchestrator, not by Harness adapters.

## 2. Register it

Import the definition in `harnesses/registry.ts` and add it to `HARNESS_DEFINITIONS`. Order is automatic-default priority. IDs are unique and also become keys for command overrides; an explicitly selected but unavailable Harness does not silently fall back to another one.

Do not add vendor-specific branches to the runner, orchestrator, or overlay. `HarnessRunner` owns probing, catalog execution, spawning, cancellation, JSONL framing, and outcome aggregation. Browser descriptors are projected from the installed definition and its live catalog.

## 3. Test the boundaries

At minimum add focused tests for:

1. catalog build/decode, including malformed and empty output;
2. turn argv/stdin for fresh and resumed turns and opaque model/effort values;
3. every supported, ignored, and malformed output-record shape;
4. registry detection and the browser descriptor;
5. cancellation and non-zero exit behavior when vendor behavior differs.

Prefer a fake executable in `packages/daemon/test/fixtures` for integration coverage. Tests must not require a real installed CLI or network access.

Run the same clean-checkout checks as CI:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build:overlay
bun run build:daemon
```

Keep protocol-neutral types in `@pincer/core`; vendor record types and parsing stay daemon-private. If a new capability cannot be represented by existing events, evolve the versioned protocol and its protocol tests separately instead of leaking raw vendor records to the browser.
