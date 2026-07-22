import { expect, test } from "bun:test";
import { modelPickerOptions } from "../src/lib/harness";

test("model picker exposes defaults, opaque current values and custom input", () => {
	const catalog = [{ id: "sonnet", label: "Sonnet", efforts: ["high"] }];

	expect(modelPickerOptions(catalog)).toEqual([
		{ id: "", label: "Default", efforts: [] },
		...catalog,
	]);
	expect(modelPickerOptions(catalog, "vendor-preview", "nightly")).toEqual([
		{ id: "", label: "Default", efforts: [] },
		{ id: "nightly", label: "Use “nightly”", efforts: [] },
		{ id: "vendor-preview", label: "vendor-preview", efforts: [] },
		...catalog,
	]);
});
