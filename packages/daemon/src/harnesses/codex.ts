import type { HarnessEvent, HarnessModel } from "@pincer/core";
import {
	decodedEvents as events,
	asRecord as record,
	asString as string,
} from "./adapter";
import { composePrompt } from "./prompt";
import type { HarnessDefinition } from "./types";

function summary(value: unknown): string {
	if (typeof value === "string") return value;
	const message = record(value);
	return message ? (string(message.message) ?? "") : "";
}

function decodeEfforts(model: Record<string, unknown>): string[] {
	const raw =
		model.supportedReasoningEfforts ?? model.supported_reasoning_efforts;
	if (!Array.isArray(raw)) return [];
	const efforts = new Set<string>();
	for (const value of raw) {
		const option = record(value);
		const effort =
			string(value) ??
			string(option?.reasoningEffort) ??
			string(option?.reasoning_effort) ??
			string(option?.value);
		if (effort) efforts.add(effort);
	}
	return [...efforts];
}

function decodeModels(output: string): HarnessModel[] {
	const parsed: unknown = JSON.parse(output);
	const root = record(parsed);
	const raw = Array.isArray(parsed)
		? parsed
		: Array.isArray(root?.models)
			? root.models
			: Array.isArray(root?.data)
				? root.data
				: [];
	const models = new Map<string, HarnessModel>();
	for (const value of raw) {
		const model = record(value);
		if (!model || model.hidden === true) continue;
		const visibility = string(model.visibility);
		if (visibility === "hide" || visibility === "hidden") continue;
		const id = string(model.model) ?? string(model.id) ?? string(model.slug);
		if (!id || models.has(id)) continue;
		const label =
			string(model.displayName) ??
			string(model.display_name) ??
			string(model.name) ??
			id;
		models.set(id, { id, label, efforts: decodeEfforts(model) });
	}
	return [...models.values()];
}

export const codexHarness: HarnessDefinition = {
	id: "codex",
	display: {
		label: "Codex",
		glyph: "{}",
		c1: "#3ecf8e",
		c2: "#199e68",
	},
	capabilities: { model: true, effort: true, resume: true },
	defaultCommand: ["codex"],
	probeArgs: ["--version"],
	catalog: {
		models: {
			build(command) {
				return { argv: [...command, "debug", "models"] };
			},
			decode: decodeModels,
		},
	},

	buildTurn(request, command) {
		const controls = [
			"--json",
			"--sandbox",
			"workspace-write",
			...(request.selection.model ? ["-m", request.selection.model] : []),
			...(request.selection.effort
				? ["-c", `model_reasoning_effort="${request.selection.effort}"`]
				: []),
		];
		const prompt = composePrompt(request);
		return {
			argv: request.resumeToken
				? [
						...command,
						"exec",
						"resume",
						...controls,
						request.resumeToken,
						prompt,
					]
				: [...command, "exec", ...controls, prompt],
		};
	},

	decodeRecord(value) {
		const message = record(value);
		if (!message)
			return { kind: "invalid", message: "Codex record must be an object" };

		const inner = record(message.msg);
		if (inner) {
			const type = string(inner.type);
			if (!type)
				return {
					kind: "invalid",
					message: "Codex legacy record is missing a string type",
				};
			if (type === "session_configured") {
				const output: HarnessEvent[] = [
					{ kind: "status", text: "codex session" },
				];
				const token = string(inner.session_id);
				if (token) output.push({ kind: "session", token });
				return events(output);
			}
			if (type === "agent_message_delta") {
				return events([{ kind: "text", text: String(inner.delta ?? "") }]);
			}
			if (type === "agent_message") {
				return events([{ kind: "text", text: String(inner.message ?? "") }]);
			}
			if (type === "exec_command_begin" || type === "patch_apply_begin") {
				return events([
					{
						kind: "tool",
						name: type === "patch_apply_begin" ? "Edit" : "Bash",
						detail: string(inner.command) ?? string(inner.path),
					},
				]);
			}
			if (type === "task_complete" || type === "turn_complete") {
				return events([
					{
						kind: "result",
						success: true,
						summary: String(inner.last_agent_message ?? ""),
					},
				]);
			}
			if (type === "task_failed" || type === "turn_failed") {
				return events([
					{ kind: "result", success: false, summary: summary(inner.error) },
				]);
			}
			if (type === "exec_command_end" || type === "patch_apply_end")
				return { kind: "ignore" };
			return {
				kind: "invalid",
				message: `Unsupported Codex legacy record type: ${type}`,
			};
		}

		const type = string(message.type);
		if (!type)
			return {
				kind: "invalid",
				message: "Codex record is missing a string type",
			};

		if (type === "thread.started") {
			const token = string(message.thread_id);
			const output: HarnessEvent[] = [
				{ kind: "status", text: "codex session" },
			];
			if (token) output.push({ kind: "session", token });
			return events(output);
		}

		if (type.startsWith("item.")) {
			const item = record(message.item);
			if (!item)
				return {
					kind: "invalid",
					message: "Codex item record is missing its item",
				};
			const itemType = string(item.item_type) ?? string(item.type);
			if (!itemType)
				return {
					kind: "invalid",
					message: "Codex item is missing a string type",
				};
			if (itemType === "assistant_message" || itemType === "agent_message") {
				return events([
					{ kind: "text", text: String(item.text ?? item.message ?? "") },
				]);
			}
			if (itemType === "command_execution" || itemType === "file_change") {
				return events([
					{
						kind: "tool",
						name: itemType === "file_change" ? "Edit" : "Bash",
						detail: string(item.command) ?? string(item.path),
					},
				]);
			}
			if (
				itemType === "reasoning" ||
				itemType === "mcp_tool_call" ||
				itemType === "web_search" ||
				itemType === "todo_list"
			) {
				return { kind: "ignore" };
			}
			if (itemType === "error") {
				return events([
					{ kind: "status", text: summary(item) || "Codex reported an error" },
				]);
			}
			return {
				kind: "invalid",
				message: `Unsupported Codex item type: ${itemType}`,
			};
		}

		if (type === "turn.started") return { kind: "ignore" };
		if (type === "turn.completed" || type === "thread.completed") {
			return events([{ kind: "result", success: true, summary: "" }]);
		}
		if (type === "turn.failed" || type === "thread.failed") {
			return events([
				{ kind: "result", success: false, summary: summary(message.error) },
			]);
		}
		if (type === "error") {
			return events([
				{ kind: "status", text: summary(message) || "Codex reported an error" },
			]);
		}
		return {
			kind: "invalid",
			message: `Unsupported Codex record type: ${type}`,
		};
	},
};
