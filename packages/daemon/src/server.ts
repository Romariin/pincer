import type { Server, ServerWebSocket } from "bun";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  PROTOCOL_VERSION,
  EFFORTS,
  isKeyboardShortcut,
  type ConversationConfig,
  type DomContext,
  type KeyboardShortcut,
  type OverlaySettings,
  type PromptElement,
  type ServerMessage,
  type SourceLocation,
} from "@pincer/core";
import { Git } from "./git";
import { Store } from "./store";
import { resolveHarnesses } from "./agents/registry";
import { Orchestrator, type Emit } from "./orchestrator";
import {
  defaultDataRoot,
  migrateLegacyProjectData,
  projectDataDir,
  projectStorageKey,
  settingsDbPath,
} from "./paths";
import { SettingsStore } from "./settingsStore";

const DAEMON_VERSION = "0.1.0";

// Browser WebSocket upgrades do not enforce CORS. Restrict browser callers to
// loopback origins; local non-browser clients omit Origin and remain supported.
const LOCAL_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)(:\d+)?$/i;

export function isLocalOrigin(origin: string | null): boolean {
  return origin === null || LOCAL_ORIGIN_RE.test(origin);
}

export interface DaemonOptions {
  projectRoot: string;
  port: number;
  agentId?: string;
  agentCommand?: string[];
  log?: (msg: string) => void;
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
    throw new Error(`Not a git repository: ${opts.projectRoot}. Pincer requires a git repo.`);
  }

  const dataRoot = opts.dataRoot ?? defaultDataRoot();
  migrateLegacyProjectData(opts.projectRoot, dataRoot, log);
  const pincerDataDir = projectDataDir(opts.projectRoot, dataRoot);

  const harnesses = await resolveHarnesses({ agentId: opts.agentId, command: opts.agentCommand });
  const store = new Store(join(pincerDataDir, "history.db"));
  const settingsStore = new SettingsStore(settingsDbPath(dataRoot));
  const orchestrator = new Orchestrator({
    git,
    store,
    projectRoot: opts.projectRoot,
    pincerDataDir,
    harnesses,
    log,
  });

  const welcome: ServerMessage = {
    v: PROTOCOL_VERSION,
    type: "welcome",
    daemonVersion: DAEMON_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    projectRoot: opts.projectRoot,
    harnesses: orchestrator.harnessAvailability(),
    efforts: [...EFFORTS],
    defaultHarnessId: orchestrator.defaultHarnessId,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const origin = req.headers.get("origin");
        if (!isLocalOrigin(origin)) {
          log(`rejected WebSocket upgrade from origin ${origin}`);
          return new Response("forbidden origin", { status: 403 });
        }
        if (srv.upgrade(req)) return undefined;
      }
      return new Response("pincer daemon");
    },
    websocket: {
      open(ws: ServerWebSocket) {
        ws.send(JSON.stringify(welcome));
      },
      async message(ws: ServerWebSocket, raw: string | Buffer) {
        const emit: Emit = (m) => {
          ws.send(JSON.stringify(m));
        };
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
          emit({ v: PROTOCOL_VERSION, type: "error", code: "bad_message", message: "Invalid JSON." });
          return;
        }
        await dispatch(orchestrator, parsed, opts.projectRoot, settingsStore, emit);
      },
      close() {},
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

function readConfig(msg: Record<string, unknown>): ConversationConfig {
  const c: ConversationConfig = {};
  if (typeof msg.harnessId === "string") c.harnessId = msg.harnessId;
  if (typeof msg.model === "string") c.model = msg.model;
  if (typeof msg.effort === "string") c.effort = msg.effort;
  return c;
}

export interface SettingsRepository {
  getSettings(appKey: string, appRoot: string, appOrigin: string): OverlaySettings;
  updateSettings(
    appKey: string,
    appRoot: string,
    appOrigin: string,
    patch: { shortcut?: KeyboardShortcut; showFloatingButton?: boolean },
  ): OverlaySettings;
}

function canonicalAppRoot(raw: unknown, daemonProjectRoot: string): string | null {
  if (typeof raw !== "string") return null;
  try {
    const projectRoot = realpathSync(daemonProjectRoot);
    const appRoot = realpathSync(raw);
    const relation = relative(projectRoot, appRoot);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null;
    return appRoot;
  } catch {
    return null;
  }
}

function canonicalAppOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function handleSettingsMessage(
  raw: Record<string, unknown>,
  daemonProjectRoot: string,
  settings: SettingsRepository,
  emit: Emit,
): boolean {
  if (raw.type !== "get_overlay_settings" && raw.type !== "update_overlay_settings") return false;

  const appRoot = canonicalAppRoot(raw.appRoot, daemonProjectRoot);
  if (!appRoot) {
    emit({ v: PROTOCOL_VERSION, type: "error", code: "bad_message", message: "Invalid app root." });
    return true;
  }
  const appOrigin = canonicalAppOrigin(raw.appOrigin);
  if (!appOrigin) {
    emit({ v: PROTOCOL_VERSION, type: "error", code: "bad_message", message: "Invalid app origin." });
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

    const hasShortcut = Object.hasOwn(raw, "shortcut");
    const hasFloatingButton = Object.hasOwn(raw, "showFloatingButton");
    if (
      (!hasShortcut && !hasFloatingButton) ||
      (hasShortcut && !isKeyboardShortcut(raw.shortcut)) ||
      (hasFloatingButton && typeof raw.showFloatingButton !== "boolean")
    ) {
      emit({
        v: PROTOCOL_VERSION,
        type: "error",
        code: "bad_message",
        message: "Invalid overlay settings update.",
      });
      return true;
    }

    const patch: { shortcut?: KeyboardShortcut; showFloatingButton?: boolean } = {};
    if (isKeyboardShortcut(raw.shortcut)) patch.shortcut = raw.shortcut;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function dispatch(
  orch: Orchestrator,
  raw: unknown,
  daemonProjectRoot: string,
  settings: SettingsRepository,
  emit: Emit,
): Promise<void> {
  if (!isRecord(raw)) {
    emit({ v: PROTOCOL_VERSION, type: "error", code: "bad_message", message: "Expected an object." });
    return;
  }
  const msg = raw;
  if (handleSettingsMessage(msg, daemonProjectRoot, settings, emit)) return;
  switch (msg.type) {
    case "list_conversations":
      emit(orch.listConversations());
      return;
    case "new_conversation":
      emit(await orch.newConversation(readConfig(msg)));
      return;
    case "resume_conversation":
      emit(await orch.resumeConversation(String(msg.conversationId)));
      return;
    case "set_config":
      emit(orch.setConfig(String(msg.conversationId), readConfig(msg)));
      return;
    case "delete_conversation":
      emit(orch.deleteConversation(String(msg.conversationId)));
      return;
    case "prompt": {
      const domContext = (msg.domContext as DomContext | undefined) ?? {
        tag: "unknown",
        id: null,
        classes: [],
        text: null,
        ancestry: [],
      };
      const elements = Array.isArray(msg.elements) ? (msg.elements as PromptElement[]) : [];
      // Fire-and-forget: runTurn streams via `emit` and owns its own errors.
      // Awaiting it here would block this connection's message loop, so a
      // subsequent `cancel` frame could never interrupt the running turn.
      void orch.runTurn(
        String(msg.conversationId),
        String(msg.prompt ?? ""),
        (msg.source as SourceLocation | null) ?? null,
        domContext,
        elements,
        emit,
      );
      return;
    }
    case "cancel":
      orch.cancel(String(msg.conversationId));
      return;
    case "revert":
      emit(await orch.revert(String(msg.conversationId)));
      return;
    case "accept":
      emit(await orch.accept(String(msg.conversationId)));
      return;
    case "discard":
      emit(await orch.discard(String(msg.conversationId)));
      return;
    default:
      emit({
        v: PROTOCOL_VERSION,
        type: "error",
        code: "bad_message",
        message: `Unknown message type: ${String(msg.type)}`,
      });
  }
}
