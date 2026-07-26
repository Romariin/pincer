import type { HarnessCatalogState, HarnessModel } from "@pincer/core";
import { normalizeModels } from "../adapter";
import type {
	HarnessDefinition,
	HarnessInvocation,
	HarnessRuntimeContext,
	InstalledHarness,
} from "../types";
import {
	CATALOG_TIMEOUT_MS,
	PROBE_TIMEOUT_MS,
	throwIfAborted,
	withDeadline,
	writeStdin,
} from "./spawn";
import { MAX_CATALOG_CHARS, readTextTail } from "./streams";

function diagnosticText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function captureCatalogOutput(
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
	return await withDeadline(
		proc,
		CATALOG_TIMEOUT_MS,
		context.signal,
		async (deadline) => {
			throwIfAborted(context.signal);
			const [exitCode, stdout] = await Promise.all([
				deadline.awaitExit(),
				readTextTail(proc.stdout, MAX_CATALOG_CHARS),
				writeStdin(proc.stdin, invocation.stdin),
			]);
			throwIfAborted(context.signal);
			if (deadline.exceeded)
				throw new Error("Harness catalog command timed out");
			if (exitCode !== 0) throw new Error("Harness catalog command failed");
			return stdout;
		},
	);
}

export async function detectHarness(
	definition: HarnessDefinition,
	command: string[],
	context: HarnessRuntimeContext = {
		projectRoot: process.cwd(),
		env: process.env,
	},
): Promise<boolean> {
	try {
		throwIfAborted(context.signal);
		const proc = Bun.spawn({
			cwd: context.projectRoot,
			env: context.env,
			cmd: [...command, ...definition.probeArgs],
			stdout: "ignore",
			stderr: "ignore",
			detached: process.platform !== "win32",
		});
		return await withDeadline(
			proc,
			PROBE_TIMEOUT_MS,
			context.signal,
			async (deadline) => {
				const exitCode = await deadline.awaitExit();
				throwIfAborted(context.signal);
				return !deadline.exceeded && exitCode === 0;
			},
		);
	} catch (error) {
		if (context.signal?.aborted) throw error;
		return false;
	}
}

export async function discoverHarnessModels(
	definition: HarnessDefinition,
	command: string[],
	context: HarnessRuntimeContext = {
		projectRoot: process.cwd(),
		env: process.env,
	},
): Promise<HarnessModel[]> {
	const source = definition.catalog;
	throwIfAborted(context.signal);
	if (!source) return [];
	const output = await captureCatalogOutput(
		source.models.build(command),
		context,
	);
	const models = source.models.decode(output);
	const effortSource = source.efforts;
	if (!effortSource) return normalizeModels(models);
	const effortResults = await Promise.allSettled(
		models.map(async (model) => {
			try {
				const effortOutput = await captureCatalogOutput(
					effortSource.build(command, model),
					context,
				);
				return { ...model, efforts: effortSource.decode(effortOutput) };
			} catch (error) {
				if (context.signal?.aborted) throw error;
				return { ...model, efforts: [] };
			}
		}),
	);
	throwIfAborted(context.signal);
	const rejected = effortResults.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (rejected) throw rejected.reason;
	const withEfforts = effortResults.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	return normalizeModels(withEfforts);
}

export async function installHarness(
	definition: HarnessDefinition,
	command: string[],
	context: HarnessRuntimeContext = {
		projectRoot: process.cwd(),
		env: process.env,
	},
): Promise<InstalledHarness> {
	throwIfAborted(context.signal);
	const detected = await detectHarness(definition, command, context);
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
			models = await discoverHarnessModels(definition, command, context);
			catalog = { status: "ready", diagnostics: [] };
		} catch (error) {
			if (context.signal?.aborted) throw error;
			catalog = {
				status: "failed",
				diagnostics: [`Harness catalog failed: ${diagnosticText(error)}`],
			};
		}
	}
	throwIfAborted(context.signal);
	return {
		definition,
		command,
		runtime: { projectRoot: context.projectRoot, env: { ...context.env } },
		detected,
		catalog,
		models,
	};
}
