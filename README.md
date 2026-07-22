# pincer

Click an element in your running app's browser preview, describe a change in
plain English, and your **already-installed CLI coding agent** (Claude Code
first) edits the real source — the dev server's HMR renders it. Pincer is
bring-your-own-agent: it never embeds a model or takes an API key.

Pincer edits the current worktree directly so the dev server's HMR can render each
change immediately. Conversations and turn output are persisted locally for
continuity; use your editor or Git to inspect and undo source changes.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (the required runtime and package manager)
- `git` on `PATH`
- A supported CLI Harness for the actual edits; without one, Pincer runs but
  reports `agent none` and blocks prompts.

## Layout

| Package | Role |
| --- | --- |
| `@pincer/core` | Runtime-neutral shared types + version constants; the two contracts and the WS protocol |
| `@pincer/daemon` | Bun process: WebSocket server, direct source editing, `bun:sqlite` history, Harness spawning; ships as the `pincer` binary |
| `@pincer/overlay` | React-based overlay injected into the preview page; validates daemon frames and manages conversation state |
| `@pincer/vite-react` | Vite + React adapter (Contract A): tags host DOM elements with their source location and injects the overlay |

## Quick start

Two ways to get the overlay into your app:

- **`pincer -- <command>` (zero install)** — wraps your dev server behind an injection
  proxy; nothing to add to the app. Source resolution falls back to DOM context
  + agent search.
- **Framework plugin** (`@pincer/vite-react`, react-grab style) — installed in
  the app; tags every element with its exact `file:line:col` (Contract A) for
  maximum precision.

```sh
# From any Git-backed app:
pincer -- bun run dev

# Or use this repository's compiled binary against the demo:
bun install
bun run build:overlay      # build the overlay bundle (needed before dev/E2E)
bun run build:daemon       # produce ./dist/pincer

# zero-install: one terminal, daemon + your dev server + injection proxy
./dist/pincer --project examples/demo -- bun run dev
# `./dist/pincer dev --project examples/demo -- bun run dev` is also supported
# → open the printed proxy URL (default http://localhost:7392)

# plugin route: terminal 1 — run the daemon against your project
./dist/pincer --project examples/demo
# terminal 2 — run the app's dev server (with @pincer/vite-react configured)
cd examples/demo && bun run dev
```

`pincer -- <command>` auto-detects the dev server URL from its output; pass
`--target http://localhost:<port>` to skip detection (with `--target` you can
also omit the command entirely and front an already-running server). The daemon
only binds `127.0.0.1` and rejects WebSocket connections from non-localhost
browser origins.

Open the printed Pincer proxy URL. Use the launcher’s copy action to pick an
element. Pincer copies its `file:line:column` when compatible source metadata is
available and an agent-ready DOM reference otherwise. Open the panel to attach
elements to a chat. Press `Alt+Shift+P` (`Option+Shift+P` on macOS) to
toggle the panel. Open Settings to choose one shortcut for every Pincer app or
hide the launcher for the current app and site. Pincer keeps history, CLI
sessions, and settings under `~/.pincer`, automatically migrates legacy
project-local data, and requires no project `.gitignore` entry.

## Bun runtime note for the optional `@pincer/vite-react` plugin

The packages are published as raw TypeScript source (`exports` → `./src`), which
Bun resolves directly with no build step. **Vite must therefore run under the
Bun runtime**, otherwise loading a `vite.config` that imports `@pincer/vite-react`
fails at config load under Node's ESM resolver (extensionless `.ts` specifiers).
The example's `dev` script uses `bunx --bun vite` for this reason; do the same in
your own project (`bunx --bun vite` / `bun run --bun dev`).

## Development

```sh
bun run lint        # Biome's recommended lint rules across the monorepo
bun run typecheck   # tsc -b across all packages
bun test            # daemon protocol suite + adapter transform + core round-trip
```
