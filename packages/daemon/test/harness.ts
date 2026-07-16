import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomContext, ServerMessage, SourceLocation } from "@pincer/core";
import { startDaemon, type RunningDaemon } from "../src/server";

export interface HarnessOptions {
  agentId?: string;
  agentCommand?: string[];
}

interface Waiter {
  pred: (m: ServerMessage) => boolean;
  resolve: (m: ServerMessage) => void;
  timer: Timer;
}

export interface Harness {
  dir: string;
  targetRel: string;
  targetAbs: string;
  appendText: string;
  userPrompt: string;
  source: SourceLocation;
  domContext: DomContext;
  get port(): number;
  send(msg: Record<string, unknown>): void;
  next<T extends ServerMessage["type"]>(type: T, timeoutMs?: number): Promise<Extract<ServerMessage, { type: T }>>;
  nextWhere(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  gitOut(args: string[]): string;
  readTarget(): string;
  readRecord(): string;
  dirtyTarget(): void;
  restart(): Promise<void>;
  close(): Promise<void>;
}

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
export const FAKE_CLAUDE = join(FIXTURE_DIR, "fake-claude.ts");
export const FAKE_CLAUDE_SLOW = join(FIXTURE_DIR, "fake-claude-slow.ts");
export const FAKE_OMP = join(FIXTURE_DIR, "fake-omp.ts");

function git(dir: string, args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  return res.stdout.toString();
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pincer-test-"));

  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "pincer@example.com"]);
  git(dir, ["config", "user.name", "Pincer Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  const targetRel = "src/App.tsx";
  const targetAbs = join(dir, targetRel);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(targetAbs, `export function App() {\n  return <button className="btn">Submit</button>;\n}\n`);
  writeFileSync(join(dir, ".gitignore"), ".pincer/\nnode_modules/\nfake-record.json\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--no-verify", "-m", "initial"]);

  const recordFile = join(dir, "fake-record.json");
  const appendText = "\n// PINCER_EDIT_MARKER\n";
  const userPrompt = "make the button say Send";

  process.env["PINCER_FAKE_TARGET"] = targetAbs;
  process.env["PINCER_FAKE_APPEND"] = appendText;
  process.env["PINCER_FAKE_RECORD"] = recordFile;

  const agentId = opts.agentId ?? "claude-code";
  const agentCommand = opts.agentCommand ?? ["bun", FAKE_CLAUDE];

  const buffered: ServerMessage[] = [];
  const waiters: Waiter[] = [];
  let ws: WebSocket;
  let daemon: RunningDaemon;

  const onMessage = (ev: MessageEvent): void => {
    // Messages come from our own daemon, which only ever sends ServerMessage.
    const msg = JSON.parse(String(ev.data)) as ServerMessage;
    const wi = waiters.findIndex((w) => w.pred(msg));
    if (wi >= 0) {
      const [w] = waiters.splice(wi, 1);
      clearTimeout(w!.timer);
      w!.resolve(msg);
    } else {
      buffered.push(msg);
    }
  };

  const connect = async (): Promise<void> => {
    daemon = await startDaemon({ projectRoot: dir, port: 0, agentId, agentCommand });
    buffered.length = 0;
    waiters.length = 0;
    ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
    ws.addEventListener("message", onMessage);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws connection error")), { once: true });
    });
  };

  await connect();

  const nextWhere = (pred: (m: ServerMessage) => boolean, timeoutMs = 15_000): Promise<ServerMessage> => {
    const idx = buffered.findIndex(pred);
    if (idx >= 0) return Promise.resolve(buffered.splice(idx, 1)[0]!);
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const wi = waiters.findIndex((w) => w.resolve === resolve);
        if (wi >= 0) waiters.splice(wi, 1);
        reject(new Error("timed out waiting for a matching message"));
      }, timeoutMs);
      waiters.push({ pred, resolve, timer });
    });
  };

  return {
    dir,
    targetRel,
    targetAbs,
    appendText,
    userPrompt,
    source: { path: targetRel, line: 2, column: 9 },
    domContext: { tag: "button", id: null, classes: ["btn"], text: "Submit", ancestry: ["button.btn", "div#root", "body"] },
    get port() {
      return daemon.port;
    },
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    next<T extends ServerMessage["type"]>(type: T, timeoutMs?: number) {
      return nextWhere((m) => m.type === type, timeoutMs) as Promise<Extract<ServerMessage, { type: T }>>;
    },
    nextWhere,
    gitOut(args) {
      return git(dir, args);
    },
    readTarget() {
      return readFileSync(targetAbs, "utf8");
    },
    readRecord() {
      return readFileSync(recordFile, "utf8");
    },
    dirtyTarget() {
      writeFileSync(targetAbs, readFileSync(targetAbs, "utf8") + "\n// dirtied\n");
    },
    async restart() {
      ws.close();
      daemon.stop();
      await connect();
    },
    async close() {
      ws.close();
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
