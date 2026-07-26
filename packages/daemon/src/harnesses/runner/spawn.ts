import type { ProcessTreeHandle } from "../../processTree";
import { stopProcessTree } from "../../processTree";

export const PROBE_TIMEOUT_MS = 5_000;
export const CATALOG_TIMEOUT_MS = 10_000;

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Harness installation aborted");
}

function isClosedPipe(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "EPIPE" || error.code === "ECONNRESET")
	);
}

interface StdinSink {
	write(data: string): unknown;
	end(): unknown;
}

/**
 * A Harness that reads its prompt from stdin may exit before we finish
 * writing; that races as EPIPE/ECONNRESET and is not a turn failure.
 */
export async function writeStdin(
	stdin: StdinSink | undefined | null,
	data: string | undefined,
): Promise<void> {
	if (data === undefined || !stdin) return;
	try {
		await stdin.write(data);
		await stdin.end();
	} catch (error) {
		if (!isClosedPipe(error)) throw error;
	}
}

export interface Deadline {
	/** True once the deadline fired and the process tree was signalled. */
	readonly exceeded: boolean;
	/** Wait for exit, then wait for the whole tree to be gone. */
	awaitExit(): Promise<number>;
}

/**
 * Runs `use` against an already-spawned process under a deadline, and always
 * reaps the process tree afterwards — on success, on throw, on timeout and on
 * abort. Every stop path funnels through one memoized `stopProcessTree` call
 * so the tree is never signalled twice.
 */
export async function withDeadline<T>(
	proc: ProcessTreeHandle,
	deadlineMs: number,
	signal: AbortSignal | undefined,
	use: (deadline: Deadline) => Promise<T>,
): Promise<T> {
	let cancellation: Promise<void> | null = null;
	let exceeded = false;
	const stop = (): void => {
		cancellation ??= stopProcessTree(proc);
	};
	const timeout = setTimeout(() => {
		exceeded = true;
		stop();
	}, deadlineMs);
	const abort = (): void => stop();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		return await use({
			get exceeded() {
				return exceeded;
			},
			awaitExit: async (): Promise<number> => {
				const exitCode = await proc.exited;
				stop();
				await cancellation;
				return exitCode;
			},
		});
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
		stop();
		await cancellation;
	}
}
