import type { Server, ServerWebSocket } from "bun";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type DomContext,
  type ServerMessage,
  type SourceLocation,
} from "@pincer/core";
import { Git } from "./git";
import { Store } from "./store";
import { resolveAgent } from "./agents/registry";
import { Orchestrator, type Emit } from "./orchestrator";

const DAEMON_VERSION = "0.1.0";

export interface DaemonOptions {
  projectRoot: string;
  port: number;
  agentId?: string;
  agentCommand?: string[];
  log?: (msg: string) => void;
}

export interface RunningDaemon {
  server: Server<undefined>;
  port: number;
  orchestrator: Orchestrator;
  stop(): void;
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const log = opts.log ?? (() => {});
  const git = new Git(opts.projectRoot);
  if (!(await git.isInsideWorkTree())) {
    throw new Error(`Not a git repository: ${opts.projectRoot}. Pincer requires a git repo.`);
  }

  const resolved = await resolveAgent({ agentId: opts.agentId, command: opts.agentCommand });
  const store = new Store(opts.projectRoot);
  const orchestrator = new Orchestrator({ git, store, projectRoot: opts.projectRoot, agent: resolved, log });

  const welcome: ServerMessage = {
    v: PROTOCOL_VERSION,
    type: "welcome",
    daemonVersion: DAEMON_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    projectRoot: opts.projectRoot,
    agent: resolved ? { id: resolved.adapter.id, detected: true } : null,
  };

  const server = Bun.serve({
    port: opts.port,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
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
        await dispatch(orchestrator, parsed, emit);
      },
      close() {},
    },
  });

  return {
    server,
    port: server.port ?? opts.port,
    orchestrator,
    stop() {
      server.stop(true);
      store.close();
    },
  };
}

async function dispatch(orch: Orchestrator, raw: unknown, emit: Emit): Promise<void> {
  if (raw === null || typeof raw !== "object") {
    emit({ v: PROTOCOL_VERSION, type: "error", code: "bad_message", message: "Expected an object." });
    return;
  }
  const msg = raw as Partial<ClientMessage> & Record<string, unknown>;

  switch (msg.type) {
    case "list_conversations":
      emit(orch.listConversations());
      return;
    case "new_conversation":
      emit(await orch.newConversation(msg.force === true));
      return;
    case "resume_conversation":
      emit(await orch.resumeConversation(String(msg.conversationId)));
      return;
    case "prompt": {
      const domContext = (msg.domContext as DomContext | undefined) ?? {
        tag: "unknown",
        id: null,
        classes: [],
        text: null,
        ancestry: [],
      };
      // Fire-and-forget: runTurn streams via `emit` and owns its own errors.
      // Awaiting it here would block this connection's message loop, so a
      // subsequent `cancel` frame could never interrupt the running turn.
      void orch.runTurn(
        String(msg.conversationId),
        String(msg.prompt ?? ""),
        (msg.source as SourceLocation | null) ?? null,
        domContext,
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
