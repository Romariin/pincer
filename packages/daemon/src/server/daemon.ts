import { join } from "node:path";
import { PROTOCOL_VERSION, type ServerMessage } from "@pincer/core";
import type { Server, ServerWebSocket } from "bun";
import { Git } from "../git";
import { harnessDescriptors, resolveHarnesses } from "../harnesses/registry";
import { isLocalOrigin } from "../localOrigin";
import { Orchestrator } from "../orchestrator/orchestrator";
import type { Emit } from "../orchestrator/types";
import {
	defaultDataRoot,
	migrateLegacyProjectData,
	projectDataDir,
	settingsDbPath,
} from "../paths";
import { SettingsStore } from "../settingsStore";
import { Store } from "../store";
import { readClientFrame } from "./clientFrame";
import { handleClientMessage } from "./dispatch";

const DAEMON_VERSION = "0.1.0";

export interface DaemonOptions {
	projectRoot: string;
	port: number;
	selectedHarnessId?: string;
	harnessCommands?: Record<string, string[]>;
	log?: (message: string) => void;
	dataRoot?: string;
	signal?: AbortSignal;
}

export interface RunningDaemon {
	server: Server<undefined>;
	port: number;
	orchestrator: Orchestrator;
	stop(): Promise<void>;
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
	const log = opts.log ?? (() => {});
	const git = new Git(opts.projectRoot);
	if (!(await git.isInsideWorkTree(opts.signal))) {
		throw new Error(
			`Not a git repository: ${opts.projectRoot}. Pincer requires a git repo.`,
		);
	}

	const dataRoot = opts.dataRoot ?? defaultDataRoot();
	migrateLegacyProjectData(opts.projectRoot, dataRoot, log);
	const pincerDataDir = projectDataDir(opts.projectRoot, dataRoot);
	const resolved = await resolveHarnesses({
		selectedId: opts.selectedHarnessId,
		commands: opts.harnessCommands,
		projectRoot: opts.projectRoot,
		env: process.env,
		signal: opts.signal,
	});
	const store = new Store(join(pincerDataDir, "history.db"));
	const settingsStore = new SettingsStore(settingsDbPath(dataRoot));
	const subscribers = new Set<ServerWebSocket>();
	const publish: Emit = (message) => {
		const serialized = JSON.stringify(message);
		for (const subscriber of subscribers) {
			try {
				subscriber.send(serialized);
			} catch {
				subscribers.delete(subscriber);
			}
		}
	};
	const orchestrator = new Orchestrator({
		git,
		store,
		projectRoot: opts.projectRoot,
		pincerDataDir,
		harnesses: resolved.harnesses,
		defaultHarnessId: resolved.defaultHarnessId,
		publish,
		log,
	});

	const welcome: ServerMessage = {
		v: PROTOCOL_VERSION,
		type: "welcome",
		daemonVersion: DAEMON_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		projectRoot: opts.projectRoot,
		harnesses: harnessDescriptors(resolved.harnesses),
		defaultHarnessId: orchestrator.defaultHarnessId,
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: opts.port,
		idleTimeout: 0,
		fetch(req, bunServer) {
			if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const origin = req.headers.get("origin");
				if (!isLocalOrigin(origin)) {
					log(`rejected WebSocket upgrade from origin ${origin}`);
					return new Response("forbidden origin", { status: 403 });
				}
				if (bunServer.upgrade(req)) return undefined;
			}
			return new Response("pincer daemon");
		},
		websocket: {
			open(ws: ServerWebSocket) {
				subscribers.add(ws);
				ws.send(JSON.stringify(welcome));
			},
			async message(ws: ServerWebSocket, raw: string | Buffer) {
				const emit: Emit = (message) => {
					ws.send(JSON.stringify(message));
				};
				const frame = readClientFrame(raw);
				if (frame.kind === "unsupported_version") {
					ws.close(1002, "Unsupported protocol version");
					return;
				}
				if (frame.kind === "rejected") {
					emit({
						v: PROTOCOL_VERSION,
						type: "error",
						code: "bad_message",
						message: frame.reason,
					});
					return;
				}
				try {
					await handleClientMessage(
						orchestrator,
						frame.message,
						opts.projectRoot,
						settingsStore,
						emit,
					);
				} catch (error) {
					log(`request failed type=${frame.message.type}: ${String(error)}`);
					const conversationId =
						"conversationId" in frame.message
							? frame.message.conversationId
							: undefined;
					emit({
						v: PROTOCOL_VERSION,
						type: "error",
						requestType: frame.message.type,
						...(conversationId === undefined ? {} : { conversationId }),
						code: "internal_error",
						message: "Request failed.",
					});
				}
			},
			close(ws: ServerWebSocket) {
				subscribers.delete(ws);
			},
		},
	});

	let stopPromise: Promise<void> | null = null;
	return {
		server,
		port: server.port ?? opts.port,
		orchestrator,
		stop() {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				await orchestrator.stop();
				server.stop(true);
				store.close();
				settingsStore.close();
			})();
			return stopPromise;
		},
	};
}
