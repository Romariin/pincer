import type { HarnessDescriptor } from "@pincer/core";

export const FALLBACK_HARNESS: HarnessDescriptor = {
	id: "",
	label: "No harness",
	glyph: "?",
	c1: "#4a4a50",
	c2: "#333338",
	detected: false,
	capabilities: {
		modelSelection: false,
		effortSelection: false,
		modelDiscovery: false,
		sessionResume: false,
	},
	models: [],
	defaultModel: "",
	efforts: [],
	defaultEffort: "",
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
	return (
		info.models.find((model) => model.id === id)?.label ?? (id || "Default")
	);
}

export function modelEfforts(
	info: HarnessDescriptor,
	modelId: string,
	current: string,
): string[] {
	const model = info.models.find((candidate) => candidate.id === modelId);
	const catalog = model?.efforts ?? info.efforts;
	if (!current || catalog.includes(current)) return catalog;
	return [current, ...catalog];
}
