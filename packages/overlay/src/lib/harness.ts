import type { HarnessDescriptor } from "@pincer/core";

export const FALLBACK_HARNESS: HarnessDescriptor = {
	id: "",
	label: "No harness",
	glyph: "?",
	c1: "#4a4a50",
	c2: "#333338",
	detected: false,
	capabilities: { model: false, effort: false, resume: false },
	catalog: { status: "unsupported", diagnostics: [] },
	models: [],
};

const EFFORT_LABEL: Record<string, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
	auto: "Auto",
};

export function effortLabel(e: string): string {
	return EFFORT_LABEL[e.toLowerCase()] ?? e;
}

export function harnessInfo(
	map: Record<string, HarnessDescriptor>,
	id: string,
): HarnessDescriptor {
	return map[id] ?? FALLBACK_HARNESS;
}

export function modelLabel(info: HarnessDescriptor, id: string): string {
	return info.models.find((model) => model.id === id)?.label ?? id;
}

export function modelEfforts(
	info: HarnessDescriptor,
	modelId: string,
	current: string,
): string[] {
	const model = info.models.find((candidate) => candidate.id === modelId);
	const catalog = model?.efforts ?? [];
	if (!current || catalog.includes(current)) return catalog;
	return [current, ...catalog];
}
