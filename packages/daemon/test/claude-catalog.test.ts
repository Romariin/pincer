import { expect, test } from "bun:test";
import { claudeHarness } from "../src/harnesses/claude";
import type { HarnessTurnRequest } from "../src/harnesses/types";

function catalog() {
	const source = claudeHarness.catalog;
	if (!source) throw new Error("Claude catalog discovery is not configured");
	return source;
}

function expectEffortQuery(
	argv: string[],
	command: string[],
	model: string,
): void {
	const modelFlag = argv.indexOf("--model");
	expect(argv.slice(modelFlag, modelFlag + 2)).toEqual(["--model", model]);
	expect([...argv.slice(0, modelFlag), ...argv.slice(modelFlag + 2)]).toEqual([
		...command,
		"-p",
		"/effort",
		"--output-format",
		"json",
		"--no-session-persistence",
		"--max-budget-usd",
		"0.000001",
	]);
}

test("Claude catalog builds staged model and model-qualified effort queries", () => {
	const source = catalog();
	const command = ["bun", "/tmp/fake claude.ts", "--wrapper-option"];

	expect(source.models.build(command)).toEqual({
		argv: [
			...command,
			"-p",
			"/model",
			"--output-format",
			"json",
			"--no-session-persistence",
			"--max-budget-usd",
			"0.000001",
		],
	});

	const efforts = source.efforts;
	if (!efforts) throw new Error("Claude effort discovery is not configured");
	expectEffortQuery(
		efforts.build(command, {
			id: "haiku",
			label: "Haiku",
			efforts: [],
		}).argv,
		command,
		"haiku",
	);
});

test("Claude catalog filters the default alias and decodes each model's advertised efforts", () => {
	const source = catalog();
	const models = source.models.decode(
		JSON.stringify({
			type: "result",
			result:
				"Current model: sonnet\nUsage: /model <name>. Available: sonnet, opus, sonnet[1m], default, or a full model ID.",
		}),
	);

	expect(models).toEqual([
		{ id: "sonnet", label: "Sonnet", efforts: [] },
		{ id: "opus", label: "Opus", efforts: [] },
		{ id: "sonnet[1m]", label: "Sonnet (1M)", efforts: [] },
	]);

	const efforts = source.efforts;
	if (!efforts) throw new Error("Claude effort discovery is not configured");
	expect(
		efforts.decode(
			JSON.stringify({
				type: "result",
				result: "Usage: /effort <low|medium|high|xhigh|max|ultracode|auto>",
			}),
		),
	).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode", "auto"]);
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
