import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ClientMessage,
	DomContext,
	ServerMessage,
	SourceLocation,
} from "@pincer/core";
import { projectDataDir } from "../src/paths";
import { type RunningDaemon, startDaemon } from "../src/server/daemon";

export interface FakeOmpExecution {
	session?: string;
	text?: string;
	textChars?: number;
	waitFor?: string;
	edits?: { path: string; append: string }[];
	spawnChildPidFile?: string;
	emitResult?: boolean;
	exitCode?: number;
}

export interface FakeOmpPlan {
	catalog?: { models: unknown[] };
	catalogExitCode?: number;
	executions?: FakeOmpExecution[];
}

export interface HarnessOptions {
	selectedHarnessId?: string;
	enableFakeClaude?: boolean;
	harnessCommands?: Record<string, string[]>;
	dataRoot?: string;
	seedLegacyData?: boolean;
	plan?: FakeOmpPlan;
}

interface Waiter {
	pred: (message: ServerMessage) => boolean;
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
	timer: Timer;
}

export interface FakeInvocation {
	index: number;
	kind: "omp" | "claude";
	argv: string[];
}

export interface Harness {
	dir: string;
	dataRoot: string;
	pincerDataDir: string;
	historyDbPath: string;
	fakeRoot: string;
	targetRel: string;
	targetAbs: string;
	appendText: string;
	userPrompt: string;
	source: SourceLocation;
	domContext: DomContext;
	get port(): number;
	send(message: ClientMessage): void;
	next<T extends ServerMessage["type"]>(
		type: T,
		timeoutMs?: number,
	): Promise<Extract<ServerMessage, { type: T }>>;
	nextWhere(
		pred: (message: ServerMessage) => boolean,
		timeoutMs?: number,
	): Promise<ServerMessage>;
	gitOut(args: string[]): string;
	readTarget(): string;
	invocations(): FakeInvocation[];
	release(name: string): void;
	disconnect(): Promise<void>;
	reconnect(): Promise<void>;
	restart(): Promise<void>;
	close(): Promise<void>;
}

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
export const FAKE_OMP = join(FIXTURE_DIR, "fake-omp.ts");
export const FAKE_RUNNER = join(FIXTURE_DIR, "fake-harness-runner.ts");

function git(dir: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: dir });
	if (result.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	return result.stdout.toString();
}

export async function createHarness(
	opts: HarnessOptions = {},
): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "pincer-test-"));
	const ownsDataRoot = opts.dataRoot === undefined;
	const dataRoot =
		opts.dataRoot ?? mkdtempSync(join(tmpdir(), "pincer-data-test-"));
	const pincerDataDir = projectDataDir(dir, dataRoot);
	const historyDbPath = join(pincerDataDir, "history.db");

	git(dir, ["init", "-b", "main"]);
	git(dir, ["config", "user.email", "pincer@example.com"]);
	git(dir, ["config", "user.name", "Pincer Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);

	const targetRel = "src/App.tsx";
	const targetAbs = join(dir, targetRel);
	const appendText = "\n// PINCER_EDIT_MARKER\n";
	const userPrompt = "make the button say Send";
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		targetAbs,
		`export function App() {\n  return <button className="btn">Submit</button>;\n}\n`,
	);
	writeFileSync(join(dir, ".gitignore"), "node_modules/\n.pincer-test/\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "--no-verify", "-m", "initial"]);

	if (opts.seedLegacyData) {
		const legacyDir = join(dir, ".pincer");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "legacy-marker"), "legacy");
	}

	const fakeRoot = join(dir, ".pincer-test");
	mkdirSync(fakeRoot, { recursive: true });
	const plan: FakeOmpPlan = opts.plan ?? {
		executions: [
			{
				session: "omp-session-1",
				text: "Applying your change…",
				edits: [{ path: targetRel, append: appendText }],
			},
		],
	};
	writeFileSync(join(fakeRoot, "plan.json"), JSON.stringify(plan));

	const harnessCommands: Record<string, string[]> = {
		"claude-code": opts.enableFakeClaude
			? ["bun", FAKE_OMP, "--fake-root", fakeRoot, "--fake-kind", "claude"]
			: [`pincer-test-missing-claude-${crypto.randomUUID()}`],
		omp: ["bun", FAKE_OMP, "--fake-root", fakeRoot, "--fake-kind", "omp"],
		codex: [`pincer-test-missing-codex-${crypto.randomUUID()}`],
		...opts.harnessCommands,
	};
	const selectedHarnessId = opts.selectedHarnessId ?? "omp";

	const buffered: ServerMessage[] = [];
	const waiters: Waiter[] = [];
	let socket: WebSocket | null = null;
	let daemon: RunningDaemon;

	const onMessage = (event: MessageEvent): void => {
		const message = JSON.parse(String(event.data)) as ServerMessage;
		const waiterIndex = waiters.findIndex((waiter) => waiter.pred(message));
		if (waiterIndex >= 0) {
			const [waiter] = waiters.splice(waiterIndex, 1);
			if (!waiter) return;
			clearTimeout(waiter.timer);
			waiter.resolve(message);
			return;
		}
		buffered.push(message);
	};

	const connectSocket = async (): Promise<void> => {
		const nextSocket = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
		nextSocket.addEventListener("message", onMessage);
		await new Promise<void>((resolve, reject) => {
			nextSocket.addEventListener("open", () => resolve(), { once: true });
			nextSocket.addEventListener(
				"error",
				() => reject(new Error("WebSocket connection failed")),
				{
					once: true,
				},
			);
		});
		socket = nextSocket;
	};

	const disconnectSocket = async (): Promise<void> => {
		const current = socket;
		socket = null;
		if (!current || current.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolve) => {
			current.addEventListener("close", () => resolve(), { once: true });
			current.close();
		});
	};

	const start = async (): Promise<void> => {
		daemon = await startDaemon({
			projectRoot: dir,
			port: 0,
			selectedHarnessId,
			harnessCommands,
			dataRoot,
		});
		await connectSocket();
	};

	await start();

	const nextWhere = (
		pred: (message: ServerMessage) => boolean,
		timeoutMs = 15_000,
	): Promise<ServerMessage> => {
		const bufferedIndex = buffered.findIndex(pred);
		if (bufferedIndex >= 0) {
			const [message] = buffered.splice(bufferedIndex, 1);
			if (message) return Promise.resolve(message);
		}
		return new Promise<ServerMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				const waiterIndex = waiters.findIndex(
					(waiter) => waiter.resolve === resolve,
				);
				if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
				reject(
					new Error(
						`timed out waiting for a matching daemon message; buffered: ${buffered
							.map((message) => {
								if (message.type === "harness_output")
									return `${message.type}:${message.event.kind}`;
								if (message.type === "turn_error")
									return `${message.type}:${message.message}`;
								return message.type;
							})
							.join(", ")}`,
					),
				);
			}, timeoutMs);
			waiters.push({ pred, resolve, reject, timer });
		});
	};

	return {
		dir,
		dataRoot,
		pincerDataDir,
		historyDbPath,
		fakeRoot,
		targetRel,
		targetAbs,
		appendText,
		userPrompt,
		source: { path: targetRel, line: 2, column: 9 },
		domContext: {
			tag: "button",
			id: null,
			classes: ["btn"],
			text: "Submit",
			ancestry: ["button.btn", "div#root", "body"],
		},
		get port() {
			return daemon.port;
		},
		send(message) {
			if (!socket || socket.readyState !== WebSocket.OPEN)
				throw new Error("WebSocket is not connected");
			socket.send(JSON.stringify(message));
		},
		next<T extends ServerMessage["type"]>(type: T, timeoutMs?: number) {
			return nextWhere(
				(message) => message.type === type,
				timeoutMs,
			) as Promise<Extract<ServerMessage, { type: T }>>;
		},
		nextWhere,
		gitOut(args) {
			return git(dir, args);
		},
		readTarget() {
			return readFileSync(targetAbs, "utf8");
		},
		invocations() {
			const path = join(fakeRoot, "invocations.jsonl");
			if (!existsSync(path)) return [];
			return readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FakeInvocation);
		},
		release(name) {
			writeFileSync(join(fakeRoot, name), "released");
		},
		disconnect: disconnectSocket,
		async reconnect() {
			buffered.length = 0;
			await connectSocket();
		},
		async restart() {
			await disconnectSocket();
			await daemon.stop();
			buffered.length = 0;
			for (const waiter of waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(
					new Error("daemon restarted while waiting for a message"),
				);
			}
			await start();
		},
		async close() {
			let stopError: unknown;
			try {
				await disconnectSocket();
				await daemon.stop();
			} catch (error) {
				stopError = error;
			} finally {
				for (const waiter of waiters.splice(0)) {
					clearTimeout(waiter.timer);
					waiter.reject(
						new Error("test harness closed while waiting for a message"),
					);
				}
				rmSync(dir, { recursive: true, force: true });
				if (ownsDataRoot) rmSync(dataRoot, { recursive: true, force: true });
			}
			if (stopError) throw stopError;
		},
	};
}
