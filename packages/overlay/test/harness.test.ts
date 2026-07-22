import { expect, test } from "bun:test";
import { effortPickerOptions, modelPickerOptions } from "../src/lib/harness";

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

test("model picker keeps opaque input distinct from a catalog label", () => {
	const catalog = [{ id: "sonnet", label: "Sonnet", efforts: ["high"] }];

	expect(modelPickerOptions(catalog, "", "Sonnet")).toEqual([
		{ id: "", label: "Default", efforts: [] },
		{ id: "Sonnet", label: "Use “Sonnet”", efforts: [] },
		...catalog,
	]);
});

test("effort picker exposes defaults, opaque current values and custom input", () => {
	expect(
		effortPickerOptions(["low", "high"], "vendor-depth", "maximum"),
	).toEqual([
		{ id: "", label: "Default", efforts: [] },
		{ id: "maximum", label: "Use “maximum”", efforts: [] },
		{ id: "vendor-depth", label: "vendor-depth", efforts: [] },
		{ id: "low", label: "Low", efforts: [] },
		{ id: "high", label: "High", efforts: [] },
	]);
});
