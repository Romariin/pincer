import { expect, test } from "bun:test";
import { codexHarness } from "../src/harnesses/codex";

const catalog = codexHarness.catalog?.models;
if (!catalog) throw new Error("Codex catalog discovery is not configured");

test("Codex catalog invokes the CLI debug models command without replacing wrapper argv", () => {
	const command = ["bun", "/tmp/fake codex.ts", "--wrapper-option"];

	expect(catalog.build(command)).toEqual({
		argv: [...command, "debug", "models"],
	});
});

test("Codex catalog decodes camelCase and snake_case effort schemas while filtering hidden models", () => {
	const models = catalog.decode(
		JSON.stringify({
			models: [
				{
					model: "gpt-5.4-codex",
					displayName: "GPT-5.4 Codex",
					supportedReasoningEfforts: [
						"low",
						{ reasoningEffort: "high" },
						{ value: "xhigh" },
						"low",
					],
				},
				{
					id: "gpt-5.3-codex",
					display_name: "GPT-5.3 Codex",
					supported_reasoning_efforts: [
						{ reasoning_effort: "minimal" },
						"medium",
					],
				},
				{
					id: "gpt-hidden-boolean",
					name: "Hidden Boolean",
					hidden: true,
					supportedReasoningEfforts: ["high"],
				},
				{
					slug: "gpt-hidden-visibility",
					name: "Hidden Visibility",
					visibility: "hidden",
					supported_reasoning_efforts: ["high"],
				},
			],
		}),
	);

	expect(models).toEqual([
		{
			id: "gpt-5.4-codex",
			label: "GPT-5.4 Codex",
			efforts: ["low", "high", "xhigh"],
		},
		{
			id: "gpt-5.3-codex",
			label: "GPT-5.3 Codex",
			efforts: ["minimal", "medium"],
		},
	]);
});

test("Codex catalog returns no models for an empty CLI response instead of a hardcoded fallback", () => {
	expect(catalog.decode(JSON.stringify({ models: [] }))).toEqual([]);
});
