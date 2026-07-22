import type { HarnessDescriptor, HarnessModel } from "@pincer/core";

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

const DEFAULT_MODEL: HarnessModel = { id: "", label: "Default", efforts: [] };

export function modelPickerOptions(
	models: readonly HarnessModel[],
	current = "",
	custom = "",
): HarnessModel[] {
	const options = [DEFAULT_MODEL, ...models.filter((model) => model.id !== "")];
	if (current && !options.some((model) => model.id === current)) {
		options.splice(1, 0, { id: current, label: current, efforts: [] });
	}
	const candidate = custom.trim();
	if (
		candidate &&
		!options.some(
			(model) => model.id === candidate || model.label === candidate,
		)
	) {
		options.splice(1, 0, {
			id: candidate,
			label: `Use “${candidate}”`,
			efforts: [],
		});
	}
	return options;
}

export function modelLabel(info: HarnessDescriptor, id: string): string {
	if (!id) return DEFAULT_MODEL.label;
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
