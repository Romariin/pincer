import type { HarnessEvent } from "@pincer/core";
import { stopProcessTree } from "../processTree";
import type { ProcessTreeHandle } from "../processTree";
import type {
	HarnessDecodeResult,
	HarnessCatalog,
	HarnessInvocation,
	HarnessDefinition,
	HarnessRunOutcome,
	HarnessTurnRequest,
	InstalledHarness,
	RunningHarnessTurn,
} from "./types";

const MAX_STDERR_CHARS = 16_384;
const MAX_DIAGNOSTICS = 20;
const PROBE_TIMEOUT_MS = 5_000;
const CATALOG_TIMEOUT_MS = 10_000;

async function readText(
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
			const chunk = decoder.decode(value, { stream: true });
			if (output.length < limit)
				output += chunk.slice(0, limit - output.length);
		}
		const tail = decoder.decode();
		return output.length < limit
			? output + tail.slice(0, limit - output.length)
			: output;
	} finally {
		reader.releaseLock();
	}
}

async function readLines(
	stream: ReadableStream<Uint8Array>,
	consume: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				consume(line);
				newline = pending.indexOf("\n");
			}
		}
		pending += decoder.decode();
		if (pending.length > 0) consume(pending.replace(/\r$/, ""));
	} finally {
		reader.releaseLock();
	}
}

async function runCatalogInvocation(
	invocation: HarnessInvocation,
): Promise<string> {
	const proc = Bun.spawn({
		cmd: invocation.argv,
		env: process.env,
		stdin: invocation.stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "ignore",
		signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
	});
	if (invocation.stdin !== undefined && proc.stdin) {
		proc.stdin.write(invocation.stdin);
		proc.stdin.end();
	}
	const stdout = await readText(proc.stdout, 1_048_576);
	if ((await proc.exited) !== 0)
		throw new Error("Harness catalog command failed");
	return stdout;
}

export class HarnessRunner {
	static async detect(
		definition: HarnessDefinition,
		command: string[],
	): Promise<boolean> {
		try {
			const proc = Bun.spawn({
				env: process.env,
				cmd: [...command, ...definition.probeArgs],
				stdout: "ignore",
				stderr: "ignore",
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			return (await proc.exited) === 0;
		} catch {
			return false;
		}
	}

	static async discoverCatalog(
		definition: HarnessDefinition,
		command: string[],
	): Promise<HarnessCatalog> {
		const fallback = (): HarnessCatalog => ({
			models: [...definition.staticModels],
			efforts: [...definition.efforts],
		});
		const source = definition.catalog;
		if (!source) return fallback();

		let models: HarnessCatalog["models"];
		try {
			const output = await runCatalogInvocation(source.models.build(command));
			const discovered = source.models.decode(output);
			models =
				discovered.length > 0 ? discovered : [...definition.staticModels];
		} catch {
			return fallback();
		}

		const effortSource = source.efforts;
		if (effortSource) {
			models = await Promise.all(
				models.map(async (model) => {
					try {
						const output = await runCatalogInvocation(
							effortSource.build(command, model),
						);
						return { ...model, efforts: effortSource.decode(output) };
					} catch {
						return { ...model, efforts: [] };
					}
				}),
			);
		}

		const discoveredEfforts = [
			...new Set(models.flatMap((model) => model.efforts ?? [])),
		];
		return {
			models,
			efforts:
				discoveredEfforts.length > 0
					? discoveredEfforts
					: [...definition.efforts],
		};
	}

	static async install(
		definition: HarnessDefinition,
		command: string[],
	): Promise<InstalledHarness> {
		const detected = await HarnessRunner.detect(definition, command);
		const catalog = detected
			? await HarnessRunner.discoverCatalog(definition, command)
			: {
					models: [...definition.staticModels],
					efforts: [...definition.efforts],
				};
		return {
			definition,
			command,
			detected,
			models: catalog.models,
			efforts: catalog.efforts,
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
					env: process.env,
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

				const stderrTask = readText(proc.stderr, MAX_STDERR_CHARS).then(
					(text) => {
						stderr = text;
					},
				);
				const stdoutTask = readLines(proc.stdout, consume);
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
				if (processHandle?.exitCode === null) {
					cancellation ??= stopProcessTree(processHandle);
					await cancellation;
				}
				await outcome;
			},
		};
	}
}
