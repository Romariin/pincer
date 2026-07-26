import type { HarnessEvent } from "@pincer/core";
import type { ProcessTreeHandle } from "../../processTree";
import { stopProcessTree } from "../../processTree";
import type {
	HarnessRunOutcome,
	HarnessTurnRequest,
	InstalledHarness,
	RunningHarnessTurn,
} from "../types";
import { createRecordReader } from "./records";
import { writeStdin } from "./spawn";
import {
	MAX_NDJSON_RECORD_BYTES,
	MAX_STDERR_CHARS,
	readLines,
	readTextTail,
} from "./streams";

export function runHarnessTurn(
	installed: InstalledHarness,
	request: HarnessTurnRequest,
	onEvent: (event: HarnessEvent) => void,
): RunningHarnessTurn {
	let cancelled = false;
	let processHandle: ProcessTreeHandle | null = null;
	let cancellation: Promise<void> | null = null;

	const outcome = (async (): Promise<HarnessRunOutcome> => {
		let stderr = "";
		let eventFailure: unknown = null;

		const reader = createRecordReader(
			installed.definition,
			onEvent,
			(error) => {
				eventFailure ??= error;
				if (processHandle) cancellation ??= stopProcessTree(processHandle);
			},
		);

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
			if (cancelled) cancellation ??= stopProcessTree(proc);

			const stderrTask = readTextTail(proc.stderr, MAX_STDERR_CHARS).then(
				(text) => {
					stderr = text;
				},
			);
			const stdoutTask = readLines(proc.stdout, reader.readRecord, () =>
				reader.diagnose(
					`Harness NDJSON record exceeded ${MAX_NDJSON_RECORD_BYTES} bytes`,
				),
			);
			const inputTask = writeStdin(proc.stdin, invocation.stdin);
			const exitTask = proc.exited.then(async (exitCode) => {
				cancellation ??= stopProcessTree(proc);
				await cancellation;
				return exitCode;
			});
			const settled = await Promise.allSettled([
				exitTask,
				stdoutTask,
				stderrTask,
				inputTask,
			]);
			const rejected = settled.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (rejected) throw rejected.reason;
			if (eventFailure) throw eventFailure;
			const exitResult = settled[0];
			if (exitResult.status !== "fulfilled") throw exitResult.reason;
			const exitCode = exitResult.value;

			if (cancelled) {
				return {
					status: "cancelled",
					sessionToken: reader.sessionToken,
					summary: "Turn cancelled.",
					diagnostics: reader.diagnostics,
					stderr,
				};
			}
			if (exitCode !== 0) {
				const detail = stderr.trim();
				return {
					status: "failed",
					sessionToken: reader.sessionToken,
					summary: detail
						? `Harness exited with code ${exitCode}: ${detail}`
						: `Harness exited with code ${exitCode}.`,
					diagnostics: reader.diagnostics,
					stderr,
				};
			}
			if (reader.terminalCount !== 1) {
				return {
					status: "failed",
					sessionToken: reader.sessionToken,
					summary:
						reader.terminalCount === 0
							? "Harness exited without a terminal result."
							: `Harness emitted ${reader.terminalCount} terminal results.`,
					diagnostics: reader.diagnostics,
					stderr,
				};
			}
			if (!reader.terminalSuccess) {
				return {
					status: "failed",
					sessionToken: reader.sessionToken,
					summary: reader.terminalSummary || "Harness reported failure.",
					diagnostics: reader.diagnostics,
					stderr,
				};
			}
			return {
				status: "succeeded",
				sessionToken: reader.sessionToken,
				summary: reader.terminalSummary,
				diagnostics: reader.diagnostics,
				stderr,
			};
		} catch (error) {
			return {
				status: cancelled ? "cancelled" : "failed",
				sessionToken: reader.sessionToken,
				summary: cancelled
					? "Turn cancelled."
					: `Failed to run Harness: ${String(error)}`,
				diagnostics: reader.diagnostics,
				stderr,
			};
		} finally {
			if (processHandle) {
				cancellation ??= stopProcessTree(processHandle);
				await cancellation;
			}
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
