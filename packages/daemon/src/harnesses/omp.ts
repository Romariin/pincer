import { join } from "node:path";
import type { HarnessEvent, HarnessModel } from "@pincer/core";
import { composePrompt } from "./prompt";
import type { HarnessDecodeResult, HarnessDefinition } from "./types";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function events(items: HarnessEvent[]): HarnessDecodeResult {
	return { kind: "events", events: items };
}

export const ompHarness: HarnessDefinition = {
	id: "omp",
	display: {
		label: "OMP",
		glyph: "◇",
		c1: "#a08be2",
		c2: "#7a5fd0",
		icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ed4abf"/><stop offset=".5" stop-color="#9b4dff"/><stop offset="1" stop-color="#5ad8e6"/></linearGradient></defs><path fill="url(#g)" d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z"/></svg>',
	},
	defaultCommand: ["omp"],
	capabilities: {
		modelSelection: true,
		effortSelection: true,
		modelDiscovery: true,
		sessionResume: true,
	},
	defaultModel: "",
	defaultEffort: "high",
	efforts: ["minimal", "low", "medium", "high", "max"],
	staticModels: [
		{ id: "", label: "Default" },
		{ id: "opus", label: "Opus" },
		{ id: "sonnet", label: "Sonnet" },
		{ id: "gpt-5", label: "GPT-5" },
	],
	probeArgs: ["--version"],
	catalog: {
		models: {
			build(command) {
				return { argv: [...command, "models", "--json"] };
			},
			decode(output) {
				const parsed = record(JSON.parse(output));
				if (!parsed || !Array.isArray(parsed.models)) return [];
				const models: HarnessModel[] = parsed.models
					.map((value): HarnessModel | null => {
						const model = record(value);
						if (!model) return null;
						const id =
							typeof model.selector === "string"
								? model.selector
								: typeof model.id === "string"
									? model.id
									: "";
						if (!id) return null;
						const label =
							typeof model.name === "string"
								? model.name
								: typeof model.id === "string"
									? model.id
									: id;
						const result: HarnessModel = { id, label };
						if (Array.isArray(model.thinking)) {
							const efforts = model.thinking.filter(
								(effort): effort is string => typeof effort === "string",
							);
							if (efforts.length > 0) result.efforts = efforts;
						}
						return result;
					})
					.filter((model): model is HarnessModel => model !== null);
				return models.length > 0
					? [{ id: "", label: "Default" }, ...models]
					: [];
			},
		},
	},

	buildTurn(request, command) {
		const argv = [
			...command,
			"-p",
			"--mode",
			"json",
			"--auto-approve",
			"--session-dir",
			join(request.pincerDataDir, "omp-sessions"),
		];
		if (request.resumeToken) argv.push("-r", request.resumeToken);
		if (request.selection.model) argv.push("--model", request.selection.model);
		if (request.selection.effort)
			argv.push("--thinking", request.selection.effort);
		argv.push(composePrompt(request));
		return { argv };
	},

	decodeRecord(value) {
		const message = record(value);
		if (!message)
			return { kind: "invalid", message: "OMP record must be an object" };
		const type = message.type;
		if (typeof type !== "string") {
			return {
				kind: "invalid",
				message: "OMP record is missing a string type",
			};
		}

		if (type === "session") {
			const id = typeof message.id === "string" ? message.id : undefined;
			const output: HarnessEvent[] = [
				{
					kind: "status",
					text: `omp session${id ? ` ${id.slice(0, 8)}` : ""}`,
				},
			];
			if (id) output.push({ kind: "session", token: id });
			return events(output);
		}

		if (type === "message_update") {
			const event = record(message.assistantMessageEvent);
			if (!event || typeof event.type !== "string") {
				return { kind: "invalid", message: "OMP message_update is malformed" };
			}
			return event.type === "text_delta"
				? events([{ kind: "text", text: String(event.delta ?? "") }])
				: { kind: "ignore" };
		}

		if (type === "tool_execution_start") {
			const args = record(message.args);
			const detail =
				args && typeof args.path === "string"
					? args.path
					: args && typeof args.file === "string"
						? args.file
						: undefined;
			return events([
				{
					kind: "tool",
					name: String(message.toolName ?? message.name ?? "tool"),
					detail,
				},
			]);
		}

		if (type === "agent_end") {
			return events([{ kind: "result", success: true, summary: "" }]);
		}

		if (
			type === "agent_start" ||
			type === "message_start" ||
			type === "message_end" ||
			type === "tool_execution_update" ||
			type === "tool_execution_end"
		) {
			return { kind: "ignore" };
		}
		return { kind: "invalid", message: `Unsupported OMP record type: ${type}` };
	},
};
