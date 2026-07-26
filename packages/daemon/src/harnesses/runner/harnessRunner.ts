import type { HarnessEvent, HarnessModel } from "@pincer/core";
import type {
	HarnessDefinition,
	HarnessRuntimeContext,
	HarnessTurnRequest,
	InstalledHarness,
	RunningHarnessTurn,
} from "../types";
import {
	detectHarness,
	discoverHarnessModels,
	installHarness,
} from "./installation";
import { runHarnessTurn } from "./turn";

/**
 * The one shared runner: probing, catalog capture, spawn, framing, event
 * delivery and cancellation all live behind it, so a HarnessDefinition only
 * ever describes vendor behavior.
 */
export class HarnessRunner {
	static detect(
		definition: HarnessDefinition,
		command: string[],
		context?: HarnessRuntimeContext,
	): Promise<boolean> {
		return detectHarness(definition, command, context);
	}

	static discoverModels(
		definition: HarnessDefinition,
		command: string[],
		context?: HarnessRuntimeContext,
	): Promise<HarnessModel[]> {
		return discoverHarnessModels(definition, command, context);
	}

	static install(
		definition: HarnessDefinition,
		command: string[],
		context?: HarnessRuntimeContext,
	): Promise<InstalledHarness> {
		return installHarness(definition, command, context);
	}

	start(
		installed: InstalledHarness,
		request: HarnessTurnRequest,
		onEvent: (event: HarnessEvent) => void,
	): RunningHarnessTurn {
		return runHarnessTurn(installed, request, onEvent);
	}
}
