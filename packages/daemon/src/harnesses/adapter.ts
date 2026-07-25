import type { HarnessEvent, HarnessModel } from "@pincer/core";
import type { HarnessDecodeResult } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function decodedEvents(events: HarnessEvent[]): HarnessDecodeResult {
	return { kind: "events", events };
}

export function normalizeModels(models: readonly HarnessModel[]): HarnessModel[] {
	const normalized = new Map<string, HarnessModel>();
	for (const model of models) {
		const id = model.id.trim();
		if (!id || normalized.has(id)) continue;
		const label = model.label.trim() || id;
		const efforts = [
			...new Set(
				model.efforts
					.filter((effort): effort is string => typeof effort === "string")
					.map((effort) => effort.trim())
					.filter(Boolean),
			),
		];
		normalized.set(id, { id, label, efforts });
	}
	return [...normalized.values()];
}
