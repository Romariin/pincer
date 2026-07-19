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
# From any Git-backed app, run its existing dev command through Pincer:
pincer -- bun run dev

# Or use this repository's compiled binary against the demo:
bun install
bun run build:overlay
bun run build:daemon
./dist/pincer --project examples/demo -- bun run dev
```

Pincer starts the daemon and child dev server, detects the child's local URL,
then prints a proxy URL to open. The proxy injects the overlay and forwards HTTP
and HMR WebSocket traffic, so per-app Pincer setup is not required. Adding
`@pincer/vite-react` remains an optional precision upgrade for exact JSX source
locations; without it, Pincer uses DOM context and agent search.

Open the printed Pincer proxy URL and use the floating crab launcher or press `Alt+Shift+P`
(`Option+Shift+P` on macOS). Open the Settings gear to choose one shortcut for
every Pincer app or hide the launcher for the current app and site. Pincer keeps
history, CLI sessions, and settings under `~/.pincer`, automatically migrates
legacy project-local data, and requires no project `.gitignore` entry.

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
