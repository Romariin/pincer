import { join } from "node:path";
import type { HarnessEvent, HarnessModel } from "@pincer/core";
import { decodedEvents as events, asRecord as record } from "./adapter";
import { composePrompt } from "./prompt";
import type { HarnessDefinition } from "./types";

export const ompHarness: HarnessDefinition = {
	id: "omp",
	display: {
		label: "OMP",
		glyph: "◇",
		c1: "#a08be2",
		c2: "#7a5fd0",
		icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ed4abf"/><stop offset=".5" stop-color="#9b4dff"/><stop offset="1" stop-color="#5ad8e6"/></linearGradient></defs><path fill="url(#g)" d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z"/></svg>',
	},
	capabilities: { model: true, effort: true, resume: true },
	defaultCommand: ["omp"],
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
						const efforts = Array.isArray(model.thinking)
							? model.thinking.filter(
									(effort): effort is string => typeof effort === "string",
								)
							: [];
						const result: HarnessModel = { id, label, efforts };
						return result;
					})
					.filter((model): model is HarnessModel => model !== null);
				return models;
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
