import overlayBundle from "@pincer/overlay/dist/overlay.js" with { type: "text" };
import type { Server, ServerWebSocket, Subprocess } from "bun";
import { CONTRACT_A_VERSION } from "@pincer/core";
import { isLocalOrigin, startDaemon, type RunningDaemon } from "./server";
import { stopProcessTree } from "./processTree";

/**
 * Wraps an app's dev server behind an injection proxy so `pincer -- <command>`
 * works without per-app setup. HTML receives the overlay config and loader;
 * all other HTTP and HMR WebSocket traffic passes through to the app server.
 * Framework plugins remain an optional source-location precision upgrade.
 */
export interface DevProxyOptions {
  target: string;
  port: number;
  wsUrl: string;
  projectRoot: string;
  log?: (message: string) => void;
}

export interface RunningProxy {
  server: Server<ProxyWsData>;
  port: number;
  stop(): void;
}

export interface ProxyWsData {
  targetUrl: string;
  protocol: string | undefined;
  upstream: WebSocket | undefined;
  pending: (string | Uint8Array)[];
}

function overlayResponse(): Response {
  return new Response(overlayBundle, {
    headers: { "content-type": "text/javascript", "cache-control": "no-store" },
  });
}

export function injectHtml(html: string, config: Record<string, unknown>): string {
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const configScript = `<script>window.__PINCER__=${json}</script>`;
  const loader = '<script type="module" src="/__pincer/overlay.js"></script>';
  let output = html.includes("</head>")
    ? html.replace("</head>", `${configScript}</head>`)
    : configScript + html;
  output = output.includes("</body>")
    ? output.replace("</body>", `${loader}</body>`)
    : output + loader;
  return output;
}
function forwardableCloseCode(code: number): number {
  return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015
    ? code
    : 1000;
}

export function startDevProxy(opts: DevProxyOptions): RunningProxy {
  const target = new URL(opts.target);
  const wsTargetBase = `${target.protocol === "https:" ? "wss" : "ws"}://${target.host}`;
  const pageConfig = {
    wsUrl: opts.wsUrl,
    contractAVersion: CONTRACT_A_VERSION,
    projectRoot: opts.projectRoot,

  };

  const server = Bun.serve<ProxyWsData>({
    hostname: "127.0.0.1",
    port: opts.port,
    async fetch(req, bunServer) {
      const url = new URL(req.url);
      if (url.pathname === "/__pincer/overlay.js") return overlayResponse();

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const origin = req.headers.get("origin");
        if (!isLocalOrigin(origin)) return new Response("forbidden origin", { status: 403 });
        const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const upgraded = bunServer.upgrade(req, {
          data: {
            targetUrl: wsTargetBase + url.pathname + url.search,
            protocol,
            upstream: undefined,
            pending: [],
          },
          headers: protocol ? { "sec-websocket-protocol": protocol } : undefined,
        });
        if (upgraded) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }

      const headers = new Headers(req.headers);
      headers.delete("host");

      headers.delete("accept-encoding");

      let upstream: Response;
      try {
        upstream = await fetch(new URL(url.pathname + url.search, target), {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          redirect: "manual",
        });
      } catch {
        return new Response(`pincer: dev server unreachable at ${opts.target}`, { status: 502 });
      }

      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("transfer-encoding");

      if ((upstream.headers.get("content-type") ?? "").includes("text/html")) {
        return new Response(injectHtml(await upstream.text(), pageConfig), {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    },
    websocket: {
      open(ws: ServerWebSocket<ProxyWsData>) {
        const upstream = new WebSocket(ws.data.targetUrl, ws.data.protocol);
        ws.data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.onopen = () => {
          for (const message of ws.data.pending) upstream.send(message);
          ws.data.pending = [];
        };
        upstream.onmessage = (event) => {
          if (typeof event.data === "string") ws.send(event.data);
          else if (event.data instanceof ArrayBuffer) ws.send(new Uint8Array(event.data));
          else if (ArrayBuffer.isView(event.data)) {
            ws.send(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
          }
        };
        upstream.onclose = (event) => ws.close(forwardableCloseCode(event.code), event.reason);
        upstream.onerror = () => ws.close(1011, "upstream websocket error");
      },
      message(ws: ServerWebSocket<ProxyWsData>, message: string | Buffer) {
        const payload = typeof message === "string" ? message : new Uint8Array(message);
        const upstream = ws.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(payload);
        else ws.data.pending.push(payload);
      },
      close(ws: ServerWebSocket<ProxyWsData>, code: number, reason: string) {
        const upstream = ws.data.upstream;
        if (
          upstream &&
          (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
        ) {
          upstream.close(forwardableCloseCode(code), reason);
        }
      },
    },
  });

  return {
    server,
    port: server.port ?? opts.port,
    stop() {
      server.stop(true);
    },
  };
}

const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function findLocalUrl(text: string): string | null {
  const match = text.replace(ANSI_RE, "").match(LOCAL_URL_RE);
  return match?.[0].replace("0.0.0.0", "127.0.0.1") ?? null;
}

interface SpawnedDev {
  child: Subprocess<"inherit", "pipe", "pipe">;

  detectedTarget: Promise<string>;
}

function spawnDevServer(command: string[], cwd: string): SpawnedDev {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: { ...process.env, FORCE_COLOR: "1" },
    detached: process.platform !== "win32",
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  let resolveTarget!: (url: string) => void;
  let rejectTarget!: (error: Error) => void;
  const detectedTarget = new Promise<string>((resolve, reject) => {
    resolveTarget = resolve;
    rejectTarget = reject;
  });
  let found = false;
  let scanned = "";
  const scan = (text: string): void => {
    if (found) return;
    scanned = (scanned + text).slice(-8192);
    const url = findLocalUrl(scanned);
    if (url) {
      found = true;
      resolveTarget(url);
    }
  };

  const tee = async (
    stream: ReadableStream<Uint8Array>,
    write: (chunk: Uint8Array) => void,
  ): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      write(value);
      scan(decoder.decode(value, { stream: true }));
    }
  };
  void tee(child.stdout, (chunk) => process.stdout.write(chunk));
  void tee(child.stderr, (chunk) => process.stderr.write(chunk));
  void child.exited.then((code) => {
    if (!found) {
      rejectTarget(new Error(`dev command exited with code ${code} before printing a local URL`));
    }
  });

  return { child, detectedTarget };
}


export interface DevOptions {
  projectRoot: string;
  daemonPort: number;
  proxyPort: number;
  command: string[];
  target?: string;
  agentId?: string;
  agentCommand?: string[];
  dataRoot?: string;
  log: (message: string) => void;
}

export async function runDev(opts: DevOptions): Promise<void> {
  const daemon: RunningDaemon = await startDaemon({
    projectRoot: opts.projectRoot,
    port: opts.daemonPort,
    agentId: opts.agentId,
    agentCommand: opts.agentCommand,
    dataRoot: opts.dataRoot,
    log: opts.log,
  });
  opts.log(
    `daemon on ws://127.0.0.1:${daemon.port}, project ${opts.projectRoot}, agent ${daemon.orchestrator.agentId ?? "none"}`,
  );

  const spawned = opts.command.length > 0 ? spawnDevServer(opts.command, opts.projectRoot) : null;
  let proxy: RunningProxy | undefined;
  let shutdownPromise: Promise<never> | null = null;
  const shutdown = (code: number): Promise<never> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      proxy?.stop();
      await Promise.all([
        spawned ? stopProcessTree(spawned.child) : Promise.resolve(),
        daemon.stop(),
      ]);
      process.exit(code);
    })();
    return shutdownPromise;
  };
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  if (spawned) void spawned.child.exited.then((code) => void shutdown(code));

  let target!: string;
  if (opts.target) target = opts.target;
  else if (!spawned) {
    opts.log("nothing to proxy: pass a command after -- or an explicit --target");
    await shutdown(1);
  } else {
    const hint = setTimeout(() => {
      opts.log(
        "still waiting for the dev server to print a local URL — pass --target http://localhost:<port> to skip detection",
      );
    }, 15_000);
    try {
      target = await spawned.detectedTarget;
    } catch (error) {
      clearTimeout(hint);
      opts.log(error instanceof Error ? error.message : String(error));
      await shutdown(1);
    }
    clearTimeout(hint);
  }

  let runningProxy!: RunningProxy;
  try {
    runningProxy = startDevProxy({
      target,
      port: opts.proxyPort,
      wsUrl: `ws://127.0.0.1:${daemon.port}`,
      projectRoot: opts.projectRoot,
      log: opts.log,
    });
  } catch (error) {
    opts.log(error instanceof Error ? error.message : String(error));
    await shutdown(1);
  }
  proxy = runningProxy;

  console.log(`\n  pincer ready → open http://localhost:${runningProxy.port}  (proxying ${target})\n`);
}
