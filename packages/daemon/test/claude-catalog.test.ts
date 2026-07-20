import { expect, test } from "bun:test";
import { claudeHarness } from "../src/harnesses/claude";
import type { HarnessTurnRequest } from "../src/harnesses/types";

function catalog() {
	const source = claudeHarness.catalog;
	if (!source) throw new Error("Claude catalog discovery is not configured");
	return source;
}

test("Claude catalog uses bounded local JSON queries for models and efforts", () => {
	expect(claudeHarness.capabilities).toMatchObject({
		modelDiscovery: true,
		effortSelection: true,
	});

	const invocations = catalog().build([
		"bun",
		"/tmp/fake claude.ts",
		"--wrapper-option",
	]);

	expect(invocations).toEqual([
		{
			argv: [
				"bun",
				"/tmp/fake claude.ts",
				"--wrapper-option",
				"-p",
				"/model",
				"--output-format",
				"json",
				"--no-session-persistence",
				"--max-budget-usd",
				"0.000001",
			],
		},
		{
			argv: [
				"bun",
				"/tmp/fake claude.ts",
				"--wrapper-option",
				"-p",
				"/effort",
				"--output-format",
				"json",
				"--no-session-persistence",
				"--max-budget-usd",
				"0.000001",
			],
		},
	]);
});

test("Claude catalog decodes advertised aliases and effort values from JSON results", () => {
	const decoded = catalog().decode([
		JSON.stringify({
			type: "result",
			result:
				"Current model: sonnet\nUsage: /model <name>. Available: sonnet, opus, sonnet[1m], default, or a full model ID.",
		}),
		JSON.stringify({
			type: "result",
			result: "Usage: /effort <low|medium|high|xhigh|max|ultracode|auto>",
		}),
	]);

	expect(decoded.models.map(({ id }) => id)).toEqual([
		"",
		"sonnet",
		"opus",
		"sonnet[1m]",
	]);
	expect(decoded.models.find(({ id }) => id === "")).toEqual({
		id: "",
		label: "Default",
	});
	expect(decoded.efforts).toEqual([
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
		"ultracode",
		"auto",
	]);
});

test("Claude turn invocation preserves opaque model and effort selections", () => {
	const command = ["bun", "/tmp/fake claude.ts", "--wrapper-option"];
	const request: HarnessTurnRequest = {
		prompt: "Apply the requested change.",
		source: null,
		domContext: {
			tag: "button",
			id: "save",
			classes: ["primary"],
			text: "Save",
			ancestry: ["main", "button#save"],
		},
		elements: [],
		projectRoot: "/tmp/project",
		pincerDataDir: "/tmp/pincer-data",
		conversationId: "conversation-1",
		selection: {
			harnessId: claudeHarness.id,
			model: "vendor/model:opaque@2026",
			effort: "vendor/effort:xhigh+preview",
		},
		resumeToken: null,
	};

	const invocation = claudeHarness.buildTurn(request, command);

	expect(invocation.argv).toEqual([
		...command,
		"-p",
		expect.stringContaining("Apply the requested change."),
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode",
		"acceptEdits",
		"--model",
		"vendor/model:opaque@2026",
		"--effort",
		"vendor/effort:xhigh+preview",
	]);
});
