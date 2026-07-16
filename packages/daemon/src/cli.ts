#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT } from "@pincer/core";
import { startDaemon } from "./server";

const HELP = `pincer — click an element in your running app, describe a change, let your CLI agent edit the source.

Usage:
  pincer [options]

Options:
  --project <dir>           Project root (must be a git repo). Default: current directory.
  --port <n>                WebSocket port. Default: ${DEFAULT_PORT}.
  --agent <id>              Force an agent adapter id (e.g. claude-code).
  --agent-command "<cmd>"   Override the agent CLI command, shell-split (e.g. "bunx claude").
  -h, --help                Show this help.

Config file (optional): pincer.config.json in the project root:
  { "port": 7391, "agent": { "id": "claude-code", "command": ["claude"] } }
Precedence: CLI flags > config file > auto-detect.
`;

interface CliArgs {
  project: string;
  port?: number;
  agentId?: string;
  agentCommand?: string[];
  help: boolean;
}

interface FileConfig {
  port?: number;
  agent?: { id?: string; command?: string[] };
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { project: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
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

const args = parseArgs(Bun.argv.slice(2));
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
