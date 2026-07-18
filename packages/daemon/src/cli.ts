#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT, DEFAULT_PROXY_PORT } from "@pincer/core";
import { runDev } from "./dev";
import { startDaemon } from "./server";

const HELP = `pincer — click an element in your running app, describe a change, let your CLI agent edit the source.

Usage:
  pincer [options]                     Start the daemon (pair with a framework plugin, e.g. @pincer/vite-react).
  pincer dev [options] -- <command>    Start the daemon AND run your dev server behind an injection
                                       proxy — no per-app install needed. Open the proxy URL.

Options:
  --project <dir>           Project root (must be a git repo). Default: current directory.
  --port <n>                Daemon WebSocket port. Default: ${DEFAULT_PORT}.
  --agent <id>              Force an agent adapter id (e.g. claude-code).
  --agent-command "<cmd>"   Override the agent CLI command, shell-split (e.g. "bunx claude").
  -h, --help                Show this help.

Options (pincer dev only):
  --proxy-port <n>          Injection proxy port. Default: ${DEFAULT_PROXY_PORT}.
  --target <url>            Upstream dev server URL. Default: auto-detected from the command's output.
  --toggle-key "<combo>"    Overlay toggle shortcut. Default: Alt+Shift+P.

Config file (optional): pincer.config.json in the project root:
  { "port": 7391, "proxyPort": 7392, "toggleKey": "Alt+Shift+P", "agent": { "id": "claude-code", "command": ["claude"] } }
Precedence: CLI flags > config file > auto-detect.
`;

interface CliArgs {
  project: string;
  port?: number;
  proxyPort?: number;
  target?: string;
  toggleKey?: string;
  agentId?: string;
  agentCommand?: string[];
  command: string[];
  help: boolean;
}

interface FileConfig {
  port?: number;
  proxyPort?: number;
  toggleKey?: string;
  agent?: { id?: string; command?: string[] };
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { project: process.cwd(), command: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--") {
      args.command = argv.slice(i + 1);
      break;
    }
    switch (flag) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--project":
        args.project = resolve(argv[++i] ?? ".");
        break;
      case "--port": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n)) args.port = n;
        break;
      }
      case "--proxy-port": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n)) args.proxyPort = n;
        break;
      }
      case "--target":
        args.target = argv[++i];
        break;
      case "--toggle-key":
        args.toggleKey = argv[++i];
        break;
      case "--agent":
        args.agentId = argv[++i];
        break;
      case "--agent-command":
        args.agentCommand = (argv[++i] ?? "").split(/\s+/).filter((w) => w.length > 0);
        break;
      default:
        break;
    }
  }
  return args;
}

function readFileConfig(projectRoot: string, log: (m: string) => void): FileConfig {
  const path = join(projectRoot, "pincer.config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (err) {
    log(`ignoring invalid pincer.config.json: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

const rawArgv = Bun.argv.slice(2);
const isDev = rawArgv[0] === "dev";
const args = parseArgs(isDev ? rawArgv.slice(1) : rawArgv);
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const log = (msg: string): void => {
  console.error(`[pincer] ${msg}`);
};

const projectRoot = resolve(args.project);
const fileConfig = readFileConfig(projectRoot, log);

const port = args.port ?? fileConfig.port ?? DEFAULT_PORT;
const agentId = args.agentId ?? fileConfig.agent?.id;
const agentCommand = args.agentCommand ?? fileConfig.agent?.command;

if (isDev) {
  if (args.command.length === 0 && !args.target) {
    console.error('usage: pincer dev [options] -- <command>   (e.g. pincer dev -- bun run dev)');
    process.exit(1);
  }
  await runDev({
    projectRoot,
    daemonPort: port,
    proxyPort: args.proxyPort ?? fileConfig.proxyPort ?? DEFAULT_PROXY_PORT,
    command: args.command,
    target: args.target,
    toggleKey: args.toggleKey ?? fileConfig.toggleKey,
    agentId,
    agentCommand,
    log,
  });
} else {
  const daemon = await startDaemon({ projectRoot, port, agentId, agentCommand, log });

  console.log(
    `pincer listening on ws://127.0.0.1:${daemon.port}, project ${projectRoot}, agent ${daemon.orchestrator.agentId ?? "none"}`,
  );

  process.on("SIGINT", () => {
    daemon.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    daemon.stop();
    process.exit(0);
  });
}
