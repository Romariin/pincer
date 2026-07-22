import type {
	DomContext,
	HarnessCapabilities,
	HarnessCatalogState,
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

export interface HarnessModelCatalogSource {
	build(command: string[]): HarnessInvocation;
	decode(output: string): HarnessModel[];
}

export interface HarnessEffortCatalogSource {
	build(command: string[], model: HarnessModel): HarnessInvocation;
	decode(output: string): string[];
}

export interface HarnessCatalogSource {
	models: HarnessModelCatalogSource;
	efforts?: HarnessEffortCatalogSource;
}

/** Daemon-private built-in extension contract. Harnesses describe vendor behavior only. */
export interface HarnessDefinition {
	readonly id: string;
	readonly display: HarnessDisplay;
	readonly capabilities: HarnessCapabilities;
	readonly defaultCommand: readonly string[];
	readonly probeArgs: readonly string[];
	readonly catalog?: HarnessCatalogSource;
	buildTurn(request: HarnessTurnRequest, command: string[]): HarnessInvocation;
	decodeRecord(record: unknown): HarnessDecodeResult;
}

export interface InstalledHarness {
	definition: HarnessDefinition;
	command: string[];
	runtime?: HarnessRuntimeContext;
	detected: boolean;
	catalog: HarnessCatalogState;
	models: HarnessModel[];
}

export interface HarnessRuntimeContext {
	projectRoot: string;
	env: Record<string, string | undefined>;
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
