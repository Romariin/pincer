import type { HarnessDescriptor } from "@pincer/core";
import { claudeHarness } from "./claude";
import { codexHarness } from "./codex";
import { ompHarness } from "./omp";
import { HarnessRunner } from "./runner";
import type { HarnessDefinition, InstalledHarness } from "./types";

export interface HarnessRegistryConfig {
	/** Explicit Harness default. Unknown ids are errors; known but unavailable ids resolve to null. */
	selectedId?: string;
	/** Per-Harness base argv overrides. Every key must name a registered Harness. */
	commands?: Record<string, string[]>;
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
	const byId = new Map(
		HARNESS_DEFINITIONS.map((definition) => [definition.id, definition]),
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

	const harnesses = await Promise.all(
		HARNESS_DEFINITIONS.map((definition) => {
			const command =
				config.commands?.[definition.id] ?? definition.defaultCommand;
			return HarnessRunner.install(definition, [...command]);
		}),
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
		models: harness.models.map((model) => ({
			...model,
			efforts: [...model.efforts],
		})),
	}));
}
