import type { HarnessEvent } from "@pincer/core";
import type { HarnessDecodeResult, HarnessDefinition } from "../types";

const MAX_DIAGNOSTICS = 20;

export interface RecordReader {
	/** Parse one NDJSON line and deliver whatever the definition decodes from it. */
	readRecord(line: string): void;
	diagnose(message: string): void;
	readonly diagnostics: string[];
	readonly sessionToken: string | null;
	readonly terminalCount: number;
	readonly terminalSuccess: boolean;
	readonly terminalSummary: string;
}

export function createRecordReader(
	definition: HarnessDefinition,
	onEvent: (event: HarnessEvent) => void,
	onEventFailure: (error: unknown) => void,
): RecordReader {
	const diagnostics: string[] = [];
	let sessionToken: string | null = null;
	let terminalCount = 0;
	let terminalSuccess = false;
	let terminalSummary = "";

	const diagnose = (message: string): void => {
		if (diagnostics.length < MAX_DIAGNOSTICS)
			diagnostics.push(message.slice(0, 1_024));
	};

	const readRecord = (line: string): void => {
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
			decoded = definition.decodeRecord(record);
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
			try {
				onEvent(event);
			} catch (error) {
				onEventFailure(error);
			}
		}
	};

	return {
		readRecord,
		diagnose,
		diagnostics,
		get sessionToken() {
			return sessionToken;
		},
		get terminalCount() {
			return terminalCount;
		},
		get terminalSuccess() {
			return terminalSuccess;
		},
		get terminalSummary() {
			return terminalSummary;
		},
	};
}
