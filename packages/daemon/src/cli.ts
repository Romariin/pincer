#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT, DEFAULT_PROXY_PORT } from "@pincer/core";
import { startDaemon } from "./server";

const HELP = `pincer — click an element in your running app, describe a change, let your CLI Harness edit the source.

Usage:
  pincer [options]                     Start the daemon (pair with a framework plugin, e.g. @pincer/vite-react).
  pincer [options] -- <command>        Run the app behind Pincer's zero-install injection proxy.
  pincer dev [options] -- <command>    Alias for the proxy form above.

Options:
  --project <dir>           Project root (must be a git repo). Default: current directory.
  --port <n>                Daemon WebSocket port. Default: ${DEFAULT_PORT}.
  --harness <id>                    Select the default Harness (e.g. claude-code).
  --harness-command '<json-argv>'   Override that Harness command (requires --harness).
  -h, --help                Show this help.

Proxy options:
  --proxy-port <n>          Injection proxy port. Default: ${DEFAULT_PROXY_PORT}.
  --target <url>            Upstream dev server URL. Default: auto-detected from the command's output.

Config file (optional): pincer.config.json in the project root:
  { "port": 7391, "proxyPort": 7392, "harnesses": { "default": "omp", "commands": { "omp": ["omp"], "claude-code": ["bunx", "claude"] } } }
Precedence: CLI flags > config file > auto-detect.
`;

interface CliArgs {
	project: string;
	port?: number;
	proxyPort?: number;
	target?: string;
	harnessId?: string;
	harnessCommand?: string[];
	command: string[];
	proxyRequested: boolean;
	help: boolean;
}

interface FileConfig {
	port?: number;
	proxyPort?: number;
	harnesses?: { default?: string; commands?: Record<string, string[]> };
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
			case "--harness":
				args.harnessId = argv[++i];
				break;
			case "--harness-command": {
				const value = argv[++i];
				let command: unknown;
				try {
					command = JSON.parse(value ?? "");
				} catch {
					throw new Error("--harness-command must be a JSON argv array");
				}
				if (
					!Array.isArray(command) ||
					command.length === 0 ||
					command.some(
						(argument) => typeof argument !== "string" || argument.length === 0,
					)
				) {
					throw new Error(
						"--harness-command must be a non-empty JSON argv array",
					);
				}
				args.harnessCommand = command as string[];
				break;
			}
			default:
				if (typeof flag === "string" && !flag.startsWith("-")) {
					// Bun consumes the shell's `--` before a shebang script sees argv.
					args.proxyRequested = true;
					args.command = argv.slice(i);
					return args;
				}
				break;
		}
	}
	return args;
}

function readFileConfig(
	projectRoot: string,
	log: (m: string) => void,
): FileConfig {
	const path = join(projectRoot, "pincer.config.json");
	if (!existsSync(path)) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		log(
			`ignoring invalid pincer.config.json: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("pincer.config.json must contain an object");
	}

	const config = parsed as FileConfig;
	const harnesses = config.harnesses;
	if (harnesses !== undefined) {
		if (
			harnesses === null ||
			typeof harnesses !== "object" ||
			Array.isArray(harnesses)
		) {
			throw new Error("pincer.config.json harnesses must be an object");
		}
		if (
			harnesses.default !== undefined &&
			typeof harnesses.default !== "string"
		) {
			throw new Error(
				"pincer.config.json harnesses.default must be a Harness id",
			);
		}
		if (
			harnesses.commands === null ||
			(harnesses.commands !== undefined &&
				(typeof harnesses.commands !== "object" ||
					Array.isArray(harnesses.commands)))
		) {
			throw new Error(
				"pincer.config.json harnesses.commands must be an object",
			);
		}
		for (const [id, command] of Object.entries(harnesses.commands ?? {})) {
			if (
				!Array.isArray(command) ||
				command.length === 0 ||
				command.some(
					(argument) => typeof argument !== "string" || argument.length === 0,
				)
			) {
				throw new Error(
					`pincer.config.json command for ${id} must be a non-empty argv array`,
				);
			}
		}
	}
	return config;
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
const selectedHarnessId = args.harnessId ?? fileConfig.harnesses?.default;
const harnessCommands: Record<string, string[]> = {
	...(fileConfig.harnesses?.commands ?? {}),
};
if (args.harnessCommand) {
	if (!args.harnessId) throw new Error("--harness-command requires --harness");
	harnessCommands[args.harnessId] = args.harnessCommand;
}
const proxyMode = isDev || args.proxyRequested || args.target !== undefined;

if (proxyMode) {
	if (args.command.length === 0 && !args.target) {
		console.error(
			"usage: pincer [options] -- <command>   (e.g. pincer -- bun run dev)",
		);
		process.exit(1);
	}
	// Proxy mode owns the generated overlay asset. Loading it here keeps the
	// daemon-only CLI independent of the overlay watcher's rebuild window.
	const { runDev } = await import("./dev");
	await runDev({
		projectRoot,
		daemonPort: port,
		proxyPort: args.proxyPort ?? fileConfig.proxyPort ?? DEFAULT_PROXY_PORT,
		command: args.command,
		target: args.target,
		selectedHarnessId,
		harnessCommands,
		log,
	});
} else {
	const daemon = await startDaemon({
		projectRoot,
		port,
		selectedHarnessId,
		harnessCommands,
		log,
	});

	console.log(
		`pincer listening on ws://127.0.0.1:${daemon.port}, project ${projectRoot}, Harness ${daemon.orchestrator.defaultHarnessId ?? "none"}`,
	);

	const shutdown = async (): Promise<never> => {
		await daemon.stop();
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());
}
