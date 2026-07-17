# pincer

Click an element in your running app's browser preview, describe a change in
plain English, and your **already-installed CLI coding agent** (Claude Code
first) edits the real source — the dev server's HMR renders it. Pincer is
bring-your-own-agent: it never embeds a model or takes an API key.

Each conversation lives on its own git branch; every turn is a git checkpoint,
so any change is revertable, acceptable (merge to base), or discardable.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (the required runtime and package manager)
- `git` on `PATH`
- A supported CLI agent for the actual edits (Claude Code); without one, Pincer
  runs but reports `agent none` and blocks prompts.

## Layout

| Package | Role |
| --- | --- |
| `@pincer/core` | Runtime-neutral shared types + version constants; the two contracts and the WS protocol |
| `@pincer/daemon` | Bun process: WebSocket server, git checkpointing, `bun:sqlite` history, agent spawning; ships as the `pincer` binary |
| `@pincer/overlay` | Dependency-free vanilla-TS overlay injected into the preview page |
| `@pincer/vite-react` | Vite + React adapter (Contract A): tags host DOM elements with their source location and injects the overlay |

## Quick start

```sh
bun install
bun run build:overlay      # build the overlay bundle (needed before dev/E2E)
bun run build:daemon       # produce ./dist/pincer

# terminal 1 — run the daemon against your project
./dist/pincer --project examples/demo

# terminal 2 — run the app's dev server
cd examples/demo && bun run dev
```

Open the Vite URL, press `Alt+Shift+P` (`Option+Shift+P` on macOS), hover to
highlight, click an element, type a change, and Submit. The shortcut matches the
physical key, so it is layout- and OS-independent (plain `Alt+P` is avoided
because Windows browsers reserve `Alt`/`Alt+<letter>` for the menu bar); override
it with `pincer({ toggleKey: "…" })`.

## Bun runtime note for `@pincer/vite-react`

The packages are published as raw TypeScript source (`exports` → `./src`), which
Bun resolves directly with no build step. **Vite must therefore run under the
Bun runtime**, otherwise loading a `vite.config` that imports `@pincer/vite-react`
fails at config load under Node's ESM resolver (extensionless `.ts` specifiers).
The example's `dev` script uses `bunx --bun vite` for this reason; do the same in
your own project (`bunx --bun vite` / `bun run --bun dev`).

## Development

```sh
bun run typecheck   # tsc -b across all packages
bun test            # daemon protocol suite + adapter transform + core round-trip
```
