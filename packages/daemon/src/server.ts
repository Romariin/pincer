import type { Server, ServerWebSocket } from "bun";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	MAX_CLIENT_FRAME_BYTES,
	PROTOCOL_VERSION,
	parseClientMessage,
	type ClientMessage,
	type ConversationConfig,
	type KeyboardShortcut,
	type OverlaySettings,
	type ServerMessage,
} from "@pincer/core";
import { Git } from "./git";
import { Store } from "./store";
import { harnessDescriptors, resolveHarnesses } from "./harnesses/registry";
import { Orchestrator } from "./orchestrator";
import type { Emit } from "./orchestrator";
import {
	defaultDataRoot,
	migrateLegacyProjectData,
	projectDataDir,
	projectStorageKey,
	settingsDbPath,
} from "./paths";
import { SettingsStore } from "./settingsStore";

const DAEMON_VERSION = "0.1.0";

// Browsers do not apply CORS to WebSocket upgrades, so without this check any
// web page (or a DNS-rebound origin) could connect and drive a Harness that
// edits local files. Non-browser clients send no Origin header and are local
// by virtue of the 127.0.0.1 bind.
const LOCAL_ORIGIN_RE =
	/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)(:\d+)?$/i;

export function isLocalOrigin(origin: string | null): boolean {
	return origin === null || LOCAL_ORIGIN_RE.test(origin);
}

export interface DaemonOptions {
	projectRoot: string;
	port: number;
	selectedHarnessId?: string;
	harnessCommands?: Record<string, string[]>;
	log?: (message: string) => void;
	dataRoot?: string;
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
	if (!(await git.isInsideWorkTree())) {
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
				const frameBytes =
					typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
				if (frameBytes > MAX_CLIENT_FRAME_BYTES) {
					emit({
						v: PROTOCOL_VERSION,
						type: "error",
						code: "bad_message",
						message: "Message is too large.",
					});
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
				} catch {
					emit({
						v: PROTOCOL_VERSION,
						type: "error",
						code: "bad_message",
						message: "Invalid JSON.",
					});
					return;
				}
				const result = parseClientMessage(parsed);
				if (!result.ok) {
					emit({
						v: PROTOCOL_VERSION,
						type: "error",
						code: "bad_message",
						message: result.error,
					});
					return;
				}
				await dispatch(
					orchestrator,
					result.value,
					opts.projectRoot,
					settingsStore,
					emit,
				);
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

function readConfig(msg: ConversationConfig): ConversationConfig {
	return {
		...(msg.harnessId === undefined ? {} : { harnessId: msg.harnessId }),
		...(msg.model === undefined ? {} : { model: msg.model }),
		...(msg.effort === undefined ? {} : { effort: msg.effort }),
	};
}

export interface SettingsRepository {
	getSettings(
		appKey: string,
		appRoot: string,
		appOrigin: string,
	): OverlaySettings;
	updateSettings(
		appKey: string,
		appRoot: string,
		appOrigin: string,
		patch: { shortcut?: KeyboardShortcut; showFloatingButton?: boolean },
	): OverlaySettings;
}

function canonicalAppRoot(
	raw: string,
	daemonProjectRoot: string,
): string | null {
	try {
		const projectRoot = realpathSync(daemonProjectRoot);
		const appRoot = realpathSync(raw);
		const relation = relative(projectRoot, appRoot);
		if (
			relation === ".." ||
			relation.startsWith(`..${sep}`) ||
			isAbsolute(relation)
		)
			return null;
		return appRoot;
	} catch {
		return null;
	}
}

function canonicalAppOrigin(raw: string): string | null {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.origin;
	} catch {
		return null;
	}
}

type SettingsMessage = Extract<
	ClientMessage,
	{ type: "get_overlay_settings" | "update_overlay_settings" }
>;

export function handleSettingsMessage(
	raw: SettingsMessage,
	daemonProjectRoot: string,
	settings: SettingsRepository,
	emit: Emit,
): boolean {
	const appRoot = canonicalAppRoot(raw.appRoot, daemonProjectRoot);
	if (!appRoot) {
		emit({
			v: PROTOCOL_VERSION,
			type: "error",
			code: "bad_message",
			message: "Invalid app root.",
		});
		return true;
	}
	const appOrigin = canonicalAppOrigin(raw.appOrigin);
	if (!appOrigin) {
		emit({
			v: PROTOCOL_VERSION,
			type: "error",
			code: "bad_message",
			message: "Invalid app origin.",
		});
		return true;
	}

	const appKey = projectStorageKey(appRoot);
	try {
		if (raw.type === "get_overlay_settings") {
			emit({
				v: PROTOCOL_VERSION,
				type: "overlay_settings",
				settings: settings.getSettings(appKey, appRoot, appOrigin),
			});
			return true;
		}

		const patch: { shortcut?: KeyboardShortcut; showFloatingButton?: boolean } =
			{};
		if (raw.shortcut) patch.shortcut = raw.shortcut;
		if (typeof raw.showFloatingButton === "boolean") {
			patch.showFloatingButton = raw.showFloatingButton;
		}
		emit({
			v: PROTOCOL_VERSION,
			type: "overlay_settings",
			settings: settings.updateSettings(appKey, appRoot, appOrigin, patch),
		});
	} catch {
		emit({
			v: PROTOCOL_VERSION,
			type: "error",
			code: "settings_unavailable",
			message: "Pincer settings are unavailable.",
		});
	}
	return true;
}

async function dispatch(
	orch: Orchestrator,
	msg: ClientMessage,
	daemonProjectRoot: string,
	settings: SettingsRepository,
	emit: Emit,
): Promise<void> {
	switch (msg.type) {
		case "list_conversations":
			emit(orch.listConversations());
			return;
		case "new_conversation":
			emit(await orch.newConversation(readConfig(msg)));
			return;
		case "resume_conversation":
			emit(orch.resumeConversation(msg.conversationId));
			return;
		case "set_config":
			emit(orch.setConfig(msg.conversationId, readConfig(msg)));
			return;
		case "delete_conversation":
			emit(await orch.deleteConversation(msg.conversationId));
			return;
		case "prompt": {
			const rejection = orch.submitTurn(
				msg.conversationId,
				msg.prompt,
				msg.source,
				msg.domContext,
				msg.elements ?? [],
			);
			if (rejection) emit(rejection);
			return;
		}
		case "cancel":
			await orch.cancel(msg.conversationId);
			return;
		case "revert":
			emit(await orch.revert(msg.conversationId));
			return;
		case "accept":
			emit(await orch.accept(msg.conversationId));
			return;
		case "discard":
			emit(await orch.discard(msg.conversationId));
			return;
		case "get_overlay_settings":
		case "update_overlay_settings":
			handleSettingsMessage(msg, daemonProjectRoot, settings, emit);
			return;
	}
}
