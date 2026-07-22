import { expect, test } from "bun:test";
import { claudeHarness } from "../src/harnesses/claude";
import type { HarnessTurnRequest } from "../src/harnesses/types";

function catalog() {
	const source = claudeHarness.catalog;
	if (!source) throw new Error("Claude catalog discovery is not configured");
	return source;
}

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function controlResponse(models: unknown): string {
	return `${JSON.stringify({
		type: "control_response",
		response: {
			subtype: "success",
			request_id: "pincer-catalog",
			response: { models },
		},
	})}\n`;
}

test("Claude catalog initializes the control protocol instead of querying slash commands", () => {
	const source = catalog();
	const command = ["bun", "/tmp/fake claude.ts", "--wrapper-option"];

	expect(source.models.build(command)).toEqual({
		argv: [
			...command,
			"--output-format",
			"stream-json",
			"--verbose",
			"--input-format",
			"stream-json",
			"--setting-sources=user,project,local",
			"--permission-mode",
			"default",
		],
		stdin: `${JSON.stringify({
			type: "control_request",
			request_id: "pincer-catalog",
			request: {
				subtype: "initialize",
				systemPrompt: [""],
			},
		})}\n`,
	});
	expect(source.efforts).toBeUndefined();
});

test("Claude catalog exposes only non-default picker rows and their advertised efforts", () => {
	const source = catalog();
	const models = source.models.decode(
		controlResponse([
			{
				value: "default",
				displayName: "Default",
				supportsEffort: true,
				supportedEffortLevels: ALL_EFFORTS,
			},
			{
				value: "opus[1m]",
				displayName: "Opus",
				supportsEffort: true,
				supportedEffortLevels: ALL_EFFORTS,
			},
			{
				value: "claude-fable-5[1m]",
				displayName: "Fable",
				supportsEffort: true,
				supportedEffortLevels: ALL_EFFORTS,
			},
			{
				value: "sonnet",
				displayName: "Sonnet",
				supportsEffort: true,
				supportedEffortLevels: ALL_EFFORTS,
			},
			{
				value: "haiku",
				displayName: "Haiku",
				supportsEffort: false,
				supportedEffortLevels: ALL_EFFORTS,
			},
		]),
	);

	expect(models).toEqual([
		{ id: "opus[1m]", label: "Opus", efforts: ALL_EFFORTS },
		{
			id: "claude-fable-5[1m]",
			label: "Fable",
			efforts: ALL_EFFORTS,
		},
		{ id: "sonnet", label: "Sonnet", efforts: ALL_EFFORTS },
		{ id: "haiku", label: "Haiku", efforts: [] },
	]);
});

test("Claude catalog uses the picker row's exact supported effort levels", () => {
	expect(
		catalog().models.decode(
			controlResponse([
				{
					value: "sonnet",
					displayName: "Sonnet",
					supportsEffort: true,
					supportedEffortLevels: ["medium", "max"],
				},
			]),
		),
	).toEqual([{ id: "sonnet", label: "Sonnet", efforts: ["medium", "max"] }]);
});

test.each([
	{
		name: "malformed NDJSON",
		output: "not json\n",
	},
	{
		name: "a non-success response",
		output: `${JSON.stringify({
			type: "control_response",
			response: {
				subtype: "error",
				request_id: "pincer-catalog",
				error: "initialization failed",
			},
		})}\n`,
	},
	{
		name: "a success response with malformed models",
		output: controlResponse("not an array"),
	},
])("Claude catalog rejects $name", ({ output }) => {
	expect(() => catalog().models.decode(output)).toThrow();
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
