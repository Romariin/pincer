import type {
	HarnessCatalogState,
	HarnessEvent,
	HarnessModel,
} from "@pincer/core";
import { stopProcessTree } from "../processTree";
import type { ProcessTreeHandle } from "../processTree";
import { normalizeModels } from "./adapter";
import type {
	HarnessDecodeResult,
	HarnessDefinition,
	HarnessInvocation,
	HarnessRunOutcome,
	HarnessRuntimeContext,
	HarnessTurnRequest,
	InstalledHarness,
	RunningHarnessTurn,
} from "./types";

const MAX_STDERR_CHARS = 16_384;
const MAX_NDJSON_RECORD_BYTES = 1_048_576;
const MAX_CATALOG_CHARS = 1_048_576;
const MAX_DIAGNOSTICS = 20;
const PROBE_TIMEOUT_MS = 5_000;
const CATALOG_TIMEOUT_MS = 10_000;

async function readTextTail(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			output = (output + decoder.decode(value, { stream: true })).slice(-limit);
		}
		return (output + decoder.decode()).slice(-limit);
	} finally {
		reader.releaseLock();
	}
}

function joinBytes(parts: readonly Uint8Array[], length: number): Uint8Array {
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}

async function readLines(
	stream: ReadableStream<Uint8Array>,
	consume: (line: string) => void,
	onOversized: () => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let parts: Uint8Array[] = [];
	let length = 0;
	let oversized = false;

	const append = (part: Uint8Array): void => {
		if (oversized || part.byteLength === 0) return;
		if (length + part.byteLength > MAX_NDJSON_RECORD_BYTES) {
			parts = [];
			length = 0;
			oversized = true;
			return;
		}
		parts.push(part);
		length += part.byteLength;
	};
	const finish = (): void => {
		if (oversized) {
			onOversized();
		} else if (length > 0) {
			const bytes = joinBytes(parts, length);
			const end = bytes[length - 1] === 13 ? length - 1 : length;
			consume(decoder.decode(bytes.subarray(0, end)));
		}
		parts = [];
		length = 0;
		oversized = false;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			let start = 0;
			for (let index = 0; index < value.byteLength; index += 1) {
				if (value[index] !== 10) continue;
				append(value.subarray(start, index));
				finish();
				start = index + 1;
			}
			append(value.subarray(start));
		}
		if (oversized || length > 0) finish();
	} finally {
		reader.releaseLock();
	}
}

async function runCatalogInvocation(
	invocation: HarnessInvocation,
	context: HarnessRuntimeContext,
): Promise<string> {
	const proc = Bun.spawn({
		cmd: invocation.argv,
		cwd: context.projectRoot,
		env: context.env,
		stdin: invocation.stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "ignore",
		detached: process.platform !== "win32",
	});
	let timedOut = false;
	let cancellation: Promise<void> | null = null;
	const timeout = setTimeout(() => {
		timedOut = true;
		cancellation = stopProcessTree(proc);
	}, CATALOG_TIMEOUT_MS);
	if (invocation.stdin !== undefined && proc.stdin) {
		proc.stdin.write(invocation.stdin);
		proc.stdin.end();
	}
	try {
		const stdout = await readTextTail(proc.stdout, MAX_CATALOG_CHARS);
		const exitCode = await proc.exited;
		if (cancellation) await cancellation;
		if (timedOut) throw new Error("Harness catalog command timed out");
		if (exitCode !== 0) throw new Error("Harness catalog command failed");
		return stdout;
	} finally {
		clearTimeout(timeout);
	}
}

function diagnostic(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class HarnessRunner {
	static async detect(
		definition: HarnessDefinition,
		command: string[],
		context: HarnessRuntimeContext = {
			projectRoot: process.cwd(),
			env: process.env,
		},
	): Promise<boolean> {
		try {
			const proc = Bun.spawn({
				cwd: context.projectRoot,
				env: context.env,
				cmd: [...command, ...definition.probeArgs],
				stdout: "ignore",
				stderr: "ignore",
				detached: process.platform !== "win32",
			});
			let timedOut = false;
			let cancellation: Promise<void> | null = null;
			const timeout = setTimeout(() => {
				timedOut = true;
				cancellation = stopProcessTree(proc);
			}, PROBE_TIMEOUT_MS);
			try {
				const exitCode = await proc.exited;
				if (cancellation) await cancellation;
				return !timedOut && exitCode === 0;
			} finally {
				clearTimeout(timeout);
			}
		} catch {
			return false;
		}
	}

	static async discoverModels(
		definition: HarnessDefinition,
		command: string[],
		context: HarnessRuntimeContext = {
			projectRoot: process.cwd(),
			env: process.env,
		},
	): Promise<HarnessModel[]> {
		const source = definition.catalog;
		if (!source) return [];
		const output = await runCatalogInvocation(
			source.models.build(command),
			context,
		);
		const models = source.models.decode(output);
		const effortSource = source.efforts;
		if (!effortSource) return normalizeModels(models);
		const withEfforts = await Promise.all(
			models.map(async (model) => {
				try {
					const effortOutput = await runCatalogInvocation(
						effortSource.build(command, model),
						context,
					);
					return { ...model, efforts: effortSource.decode(effortOutput) };
				} catch {
					return { ...model, efforts: [] };
				}
			}),
		);
		return normalizeModels(withEfforts);
	}

	static async install(
		definition: HarnessDefinition,
		command: string[],
		context: HarnessRuntimeContext = {
			projectRoot: process.cwd(),
			env: process.env,
		},
	): Promise<InstalledHarness> {
		const detected = await HarnessRunner.detect(definition, command, context);
		let catalog: HarnessCatalogState;
		let models: HarnessModel[] = [];
		if (!definition.catalog) {
			catalog = { status: "unsupported", diagnostics: [] };
		} else if (!detected) {
			catalog = {
				status: "failed",
				diagnostics: ["Harness CLI probe failed; catalog was not queried"],
			};
		} else {
			try {
				models = await HarnessRunner.discoverModels(
					definition,
					command,
					context,
				);
				catalog = { status: "ready", diagnostics: [] };
			} catch (error) {
				catalog = {
					status: "failed",
					diagnostics: [`Harness catalog failed: ${diagnostic(error)}`],
				};
			}
		}
		return {
			definition,
			command,
			runtime: { projectRoot: context.projectRoot, env: { ...context.env } },
			detected,
			catalog,
			models,
		};
	}

	start(
		installed: InstalledHarness,
		request: HarnessTurnRequest,
		onEvent: (event: HarnessEvent) => void,
	): RunningHarnessTurn {
		let cancelled = false;
		let processHandle: ProcessTreeHandle | null = null;
		let cancellation: Promise<void> | null = null;

		const outcome = (async (): Promise<HarnessRunOutcome> => {
			const diagnostics: string[] = [];
			let stderr = "";
			let sessionToken: string | null = null;
			let terminalCount = 0;
			let terminalSuccess = false;
			let terminalSummary = "";

			const diagnose = (message: string): void => {
				if (diagnostics.length < MAX_DIAGNOSTICS)
					diagnostics.push(message.slice(0, 1_024));
			};

			const consume = (line: string): void => {
				if (line.trim().length === 0) return;
				let record: unknown;
				try {
					record = JSON.parse(line);
				} catch (error) {
					diagnose(`Invalid JSON record: ${String(error)}`);
					return;
				}

				let decoded: HarnessDecodeResult;
				try {
					decoded = installed.definition.decodeRecord(record);
				} catch (error) {
					diagnose(`Harness decoder failed: ${String(error)}`);
					return;
				}

				if (decoded.kind === "ignore") return;
				if (decoded.kind === "invalid") {
					diagnose(decoded.message);
					return;
				}

				for (const event of decoded.events) {
					if (event.kind === "session") {
						sessionToken = event.token;
					} else if (event.kind === "result") {
						terminalCount += 1;
						terminalSuccess = event.success;
						terminalSummary = event.summary ?? "";
					}
					onEvent(event);
				}
			};

			try {
				const invocation = installed.definition.buildTurn(
					request,
					installed.command,
				);
				const proc = Bun.spawn({
					cmd: invocation.argv,
					cwd: request.projectRoot,
					env: installed.runtime?.env ?? process.env,
					stdin: invocation.stdin === undefined ? "ignore" : "pipe",
					stdout: "pipe",
					stderr: "pipe",
					detached: process.platform !== "win32",
				});
				processHandle = proc;

				if (invocation.stdin !== undefined && proc.stdin) {
					proc.stdin.write(invocation.stdin);
					proc.stdin.end();
				}

				const stderrTask = readTextTail(proc.stderr, MAX_STDERR_CHARS).then(
					(text) => {
						stderr = text;
					},
				);
				const stdoutTask = readLines(proc.stdout, consume, () =>
					diagnose(
						`Harness NDJSON record exceeded ${MAX_NDJSON_RECORD_BYTES} bytes`,
					),
				);
				const exitCode = await proc.exited;
				await Promise.all([stdoutTask, stderrTask]);

				if (cancelled) {
					return {
						status: "cancelled",
						sessionToken,
						summary: "Turn cancelled.",
						diagnostics,
						stderr,
					};
				}
				if (exitCode !== 0) {
					const detail = stderr.trim();
					return {
						status: "failed",
						sessionToken,
						summary: detail
							? `Harness exited with code ${exitCode}: ${detail}`
							: `Harness exited with code ${exitCode}.`,
						diagnostics,
						stderr,
					};
				}
				if (terminalCount !== 1) {
					return {
						status: "failed",
						sessionToken,
						summary:
							terminalCount === 0
								? "Harness exited without a terminal result."
								: `Harness emitted ${terminalCount} terminal results.`,
						diagnostics,
						stderr,
					};
				}
				if (!terminalSuccess) {
					return {
						status: "failed",
						sessionToken,
						summary: terminalSummary || "Harness reported failure.",
						diagnostics,
						stderr,
					};
				}
				return {
					status: "succeeded",
					sessionToken,
					summary: terminalSummary,
					diagnostics,
					stderr,
				};
			} catch (error) {
				return {
					status: cancelled ? "cancelled" : "failed",
					sessionToken,
					summary: cancelled
						? "Turn cancelled."
						: `Failed to run Harness: ${String(error)}`,
					diagnostics,
					stderr,
				};
			}
		})();

		return {
			outcome,
			cancel: async () => {
				cancelled = true;
				if (processHandle) {
					cancellation ??= stopProcessTree(processHandle);
					await cancellation;
				}
				await outcome;
			},
		};
	}
}
