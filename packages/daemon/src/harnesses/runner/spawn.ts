export const PROBE_TIMEOUT_MS = 5_000;
export const CATALOG_TIMEOUT_MS = 10_000;

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Harness installation aborted");
}

export function isClosedPipe(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "EPIPE" || error.code === "ECONNRESET")
	);
}
