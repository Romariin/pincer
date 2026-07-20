import type { HarnessEvent, HarnessModel } from "@pincer/core";
import { composePrompt } from "./prompt";
import type { HarnessDecodeResult, HarnessDefinition } from "./types";

const CLAUDE_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="hsl(14.8, 63.1%, 59.6%)"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"></path></svg>';

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function events(events: HarnessEvent[]): HarnessDecodeResult {
	return { kind: "events", events };
}

function printResult(stdout: string): string {
	const message = record(JSON.parse(stdout));
	return message && typeof message.result === "string" ? message.result : "";
}

function modelLabel(id: string): string {
	const match = /^(.+?)(?:\[([^\]]+)\])?$/.exec(id);
	const name = (match?.[1] ?? id)
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());
	return match?.[2] ? `${name} (${match[2].toUpperCase()})` : name;
}

function decodeModels(stdout: string): HarnessModel[] {
	const available =
		/Available:\s*([\s\S]*?)(?:,?\s+or\s+a full model ID\.?|$)/i.exec(
			printResult(stdout),
		)?.[1];
	if (!available) return [];
	const models = new Map<string, HarnessModel>();
	for (const alias of available.split(",").map((value) => value.trim())) {
		if (!alias) continue;
		const id = alias === "default" ? "" : alias;
		if (!models.has(id)) {
			models.set(id, { id, label: id ? modelLabel(id) : "Default" });
		}
	}
	const defaultModel = models.get("");
	if (defaultModel) models.delete("");
	return defaultModel
		? [defaultModel, ...models.values()]
		: [...models.values()];
}

function decodeEfforts(stdout: string): string[] {
	const choices = /\/effort\s+<([^>]+)>/i.exec(printResult(stdout))?.[1];
	if (!choices) return [];
	return [
		...new Set(
			choices
				.split("|")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	];
}

function catalogInvocation(
	command: string[],
	slashCommand: "/model" | "/effort",
	model?: string,
) {
	return {
		argv: [
			...command,
			...(model ? ["--model", model] : []),
			"-p",
			slashCommand,
			"--output-format",
			"json",
			"--no-session-persistence",
			"--max-budget-usd",
			"0.000001",
		],
	};
}

export const claudeHarness: HarnessDefinition = {
	id: "claude-code",
	display: {
		label: "Claude Code",
		glyph: ">_",
		c1: "#d98a63",
		c2: "#c26a3f",
		icon: CLAUDE_ICON,
	},
	defaultCommand: ["claude"],
	capabilities: {
		modelSelection: true,
		effortSelection: true,
		modelDiscovery: true,
		sessionResume: true,
	},
	defaultModel: "",
	defaultEffort: "",
	efforts: [],
	staticModels: [],
	probeArgs: ["--version"],
	catalog: {
		models: {
			build(command) {
				return catalogInvocation(command, "/model");
			},
			decode: decodeModels,
		},
		efforts: {
			build(command, model) {
				return catalogInvocation(command, "/effort", model.id || "default");
			},
			decode: decodeEfforts,
		},
	},
	buildTurn(request, command) {
		return {
			argv: [
				...command,
				"-p",
				composePrompt(request),
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--permission-mode",
				"acceptEdits",
				...(request.selection.model
					? ["--model", request.selection.model]
					: []),
				...(request.selection.effort
					? ["--effort", request.selection.effort]
					: []),
				...(request.resumeToken ? ["--resume", request.resumeToken] : []),
			],
		};
	},

	decodeRecord(value) {
		const message = record(value);
		if (!message)
			return { kind: "invalid", message: "Claude record must be an object" };
		const type = message.type;
		if (typeof type !== "string") {
			return {
				kind: "invalid",
				message: "Claude record is missing a string type",
			};
		}

		if (type === "system") {
			if (message.subtype !== "init") return { kind: "ignore" };
			const model =
				typeof message.model === "string" ? ` (${message.model})` : "";
			const output: HarnessEvent[] = [
				{ kind: "status", text: `harness ready${model}` },
			];
			if (typeof message.session_id === "string") {
				output.push({ kind: "session", token: message.session_id });
			}
			return events(output);
		}

		if (type === "stream_event") {
			const event = record(message.event);
			if (!event || typeof event.type !== "string") {
				return {
					kind: "invalid",
					message: "Claude stream_event is missing its event type",
				};
			}
			if (event.type === "content_block_delta") {
				const delta = record(event.delta);
				if (!delta || typeof delta.type !== "string") {
					return {
						kind: "invalid",
						message: "Claude content delta is malformed",
					};
				}
				return delta.type === "text_delta"
					? events([{ kind: "text", text: String(delta.text ?? "") }])
					: { kind: "ignore" };
			}
			if (event.type === "content_block_start") {
				const block = record(event.content_block);
				if (!block || typeof block.type !== "string") {
					return {
						kind: "invalid",
						message: "Claude content block is malformed",
					};
				}
				if (block.type !== "tool_use") return { kind: "ignore" };
				const input = record(block.input);
				const detail =
					input && typeof input.file_path === "string"
						? input.file_path
						: undefined;
				return events([
					{ kind: "tool", name: String(block.name ?? "tool"), detail },
				]);
			}
			return { kind: "ignore" };
		}

		if (type === "result") {
			const output: HarnessEvent[] = [];
			if (typeof message.session_id === "string") {
				output.push({ kind: "session", token: message.session_id });
			}
			output.push({
				kind: "result",
				success: message.is_error !== true,
				summary: String(message.result ?? "").slice(0, 500),
			});
			return events(output);
		}

		if (
			type === "assistant" ||
			type === "user" ||
			type === "rate_limit_event" ||
			type === "control_response"
		) {
			return { kind: "ignore" };
		}
		return {
			kind: "invalid",
			message: `Unsupported Claude record type: ${type}`,
		};
	},
};
