#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT, DEFAULT_PROXY_PORT } from "@pincer/core";
import { runDev } from "./dev";
import { startDaemon } from "./server";

const HELP = `pincer — click an element in your running app, describe a change, let your CLI agent edit the source.

Usage:
  pincer [options]                     Start only the daemon for a framework-integrated app.
  pincer [options] -- <command>        Run the app behind Pincer's zero-install injection proxy.
  pincer dev [options] -- <command>    Alias for the proxy form above.

Options:
  --project <dir>           Project root and child-command cwd. Default: current directory.
  --port <n>                Daemon WebSocket port. Default: ${DEFAULT_PORT}.
  --proxy-port <n>          Injection proxy port. Default: ${DEFAULT_PROXY_PORT}.
  --target <url>            Proxy an already-running server instead of detecting the child URL.
  --agent <id>              Force an agent adapter id (e.g. claude-code).
  --agent-command "<cmd>"   Override the agent CLI command, shell-split (e.g. "bunx claude").
  -h, --help                Show this help.

Config file (optional): pincer.config.json in the project root:
  { "port": 7391, "proxyPort": 7392, "agent": { "id": "claude-code", "command": ["claude"] } }
Precedence: CLI flags > config file > defaults.
`;

interface CliArgs {
  project: string;
  port?: number;
  proxyPort?: number;
  target?: string;
  agentId?: string;
  agentCommand?: string[];
  command: string[];
  proxyRequested: boolean;
  help: boolean;
}

interface FileConfig {
  port?: number;
  proxyPort?: number;
  agent?: { id?: string; command?: string[] };
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    project: process.cwd(),
    command: [],
    proxyRequested: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--") {
      args.proxyRequested = true;
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
        const value = Number(argv[++i]);
        if (Number.isFinite(value)) args.port = value;
        break;
      }
      case "--proxy-port": {
        const value = Number(argv[++i]);
        if (Number.isFinite(value)) args.proxyPort = value;
        break;
      }
      case "--target":
        args.target = argv[++i];
        break;
      case "--agent":
        args.agentId = argv[++i];
        break;
      case "--agent-command":
        args.agentCommand = (argv[++i] ?? "").split(/\s+/).filter((word) => word.length > 0);
        break;
      default:
        if (typeof flag === "string" && !flag.startsWith("-")) {
          // Bun consumes the shell's `--` before a shebang script sees argv.
          // The first positional token therefore begins the child command.
          args.proxyRequested = true;
          args.command = argv.slice(i);
          return args;
        }
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
const devAlias = rawArgv[0] === "dev";
const args = parseArgs(devAlias ? rawArgv.slice(1) : rawArgv);
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const log = (message: string): void => {
  console.error(`[pincer] ${message}`);
};

const projectRoot = resolve(args.project);
const fileConfig = readFileConfig(projectRoot, log);
const port = args.port ?? fileConfig.port ?? DEFAULT_PORT;
const agentId = args.agentId ?? fileConfig.agent?.id;
const agentCommand = args.agentCommand ?? fileConfig.agent?.command;
const proxyMode = devAlias || args.proxyRequested || args.target !== undefined;

if (proxyMode) {
  if (args.command.length === 0 && !args.target) {
    console.error("usage: pincer [options] -- <command>   (e.g. pincer -- bun run dev)");
    process.exit(1);
  }
  await runDev({
    projectRoot,
    daemonPort: port,
    proxyPort: args.proxyPort ?? fileConfig.proxyPort ?? DEFAULT_PROXY_PORT,
    command: args.command,
    target: args.target,
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
