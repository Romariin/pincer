import type {
	DomContext,
	HarnessCapabilities,
	HarnessDisplay,
	HarnessEvent,
	HarnessModel,
	HarnessSelection,
	PromptElement,
	SourceLocation,
} from "@pincer/core";

export interface HarnessTurnRequest {
	prompt: string;
	source: SourceLocation | null;
	domContext: DomContext;
	elements?: PromptElement[];
	projectRoot: string;
	pincerDataDir: string;
	conversationId: string;
	selection: HarnessSelection;
	resumeToken: string | null;
}

export interface HarnessInvocation {
	argv: string[];
	stdin?: string;
}

export type HarnessDecodeResult =
	| { kind: "events"; events: HarnessEvent[] }
	| { kind: "ignore" }
	| { kind: "invalid"; message: string };

export interface HarnessModelCatalog {
	build(command: string[]): HarnessInvocation;
	decode(stdout: string): HarnessModel[];
}

/** Daemon-private built-in extension contract. Harnesses describe vendor behavior only. */
export interface HarnessDefinition {
	readonly id: string;
	readonly display: HarnessDisplay;
	readonly defaultCommand: readonly string[];
	readonly capabilities: HarnessCapabilities;
	readonly defaultModel: string;
	readonly defaultEffort: string;
	readonly efforts: readonly string[];
	readonly staticModels: readonly HarnessModel[];
	readonly probeArgs: readonly string[];
	readonly catalog?: HarnessModelCatalog;
	buildTurn(request: HarnessTurnRequest, command: string[]): HarnessInvocation;
	decodeRecord(record: unknown): HarnessDecodeResult;
}

export interface InstalledHarness {
	definition: HarnessDefinition;
	command: string[];
	detected: boolean;
	models: HarnessModel[];
}

export interface HarnessRunOutcome {
	status: "succeeded" | "failed" | "cancelled";
	sessionToken: string | null;
	summary: string;
	diagnostics: string[];
	stderr: string;
}

export interface RunningHarnessTurn {
	outcome: Promise<HarnessRunOutcome>;
	cancel(): Promise<void>;
}
