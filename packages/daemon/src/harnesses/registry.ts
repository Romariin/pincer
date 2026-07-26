import type { HarnessDescriptor } from "@pincer/core";
import { claudeHarness } from "./claude";
import { codexHarness } from "./codex";
import { ompHarness } from "./omp";
import { HarnessRunner } from "./runner/harnessRunner";
import type {
	HarnessDefinition,
	HarnessRuntimeContext,
	InstalledHarness,
} from "./types";

export interface HarnessRegistryConfig {
	/** Definitions to resolve. Defaults to the built-in deterministic list. */
	definitions?: readonly HarnessDefinition[];
	/** Explicit Harness default. Unknown ids are errors; known but unavailable ids resolve to null. */
	selectedId?: string;
	/** Per-Harness base argv overrides. Every key must name a registered Harness. */
	commands?: Record<string, string[]>;
	/** Project and environment used by CLI probes and advisory catalog commands. */
	projectRoot?: string;
	env?: HarnessRuntimeContext["env"];
	signal?: AbortSignal;
}

export interface ResolvedHarnesses {
	harnesses: InstalledHarness[];
	defaultHarnessId: string | null;
}

/** Validate and freeze a statically ordered definition list. */
export function defineHarnesses(
	definitions: readonly HarnessDefinition[],
): readonly HarnessDefinition[] {
	const ids = new Set<string>();
	for (const definition of definitions) {
		if (ids.has(definition.id)) {
			throw new Error(`Duplicate Harness id: ${definition.id}`);
		}
		ids.add(definition.id);
	}
	return Object.freeze([...definitions]);
}

/** Built-ins in deterministic automatic-default priority order. */
export const HARNESS_DEFINITIONS = defineHarnesses([
	claudeHarness,
	ompHarness,
	codexHarness,
]);

/**
 * Resolve commands and probe every built-in through HarnessRunner. An explicit
 * unavailable default remains unavailable instead of falling back by priority.
 */
export async function resolveHarnesses(
	config: HarnessRegistryConfig = {},
): Promise<ResolvedHarnesses> {
	const definitions = defineHarnesses(
		config.definitions ?? HARNESS_DEFINITIONS,
	);
	const byId = new Map(
		definitions.map((definition) => [definition.id, definition]),
	);
	if (config.selectedId !== undefined && !byId.has(config.selectedId)) {
		throw new Error(`Unknown Harness id: ${config.selectedId}`);
	}

	for (const [id, command] of Object.entries(config.commands ?? {})) {
		if (!byId.has(id))
			throw new Error(`Unknown Harness command override id: ${id}`);
		if (
			!Array.isArray(command) ||
			command.length === 0 ||
			command.some(
				(argument) => typeof argument !== "string" || argument.length === 0,
			)
		) {
			throw new Error(
				`Harness command override for ${id} must be a non-empty argv array`,
			);
		}
	}

	const installations = await Promise.allSettled(
		definitions.map((definition) => {
			const command =
				config.commands?.[definition.id] ?? definition.defaultCommand;
			return HarnessRunner.install(definition, [...command], {
				projectRoot: config.projectRoot ?? process.cwd(),
				env: config.env ?? process.env,
				signal: config.signal,
			});
		}),
	);
	const rejected = installations.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (rejected) throw rejected.reason;
	const harnesses = installations.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);

	const defaultHarnessId = config.selectedId
		? harnesses.find((harness) => harness.definition.id === config.selectedId)
				?.detected
			? config.selectedId
			: null
		: (harnesses.find((harness) => harness.detected)?.definition.id ?? null);

	return { harnesses, defaultHarnessId };
}

/** Project installed Harnesses onto the browser-safe startup protocol shape. */
export function harnessDescriptors(
	harnesses: readonly InstalledHarness[],
): HarnessDescriptor[] {
	return harnesses.map((harness) => ({
		id: harness.definition.id,
		...harness.definition.display,
		detected: harness.detected,
		capabilities: { ...harness.definition.capabilities },
		catalog: {
			status: harness.catalog.status,
			diagnostics: [...harness.catalog.diagnostics],
		},
		models: harness.models.map((model) => ({
			...model,
			efforts: [...model.efforts],
		})),
	}));
}
