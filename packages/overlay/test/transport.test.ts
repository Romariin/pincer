import { describe, expect, test } from "bun:test";
import type { ClientMessage } from "@pincer/core";
import { PROTOCOL_VERSION, parseClientMessage } from "@pincer/core";
import { daemon } from "../src/state/transport";
import { domContext } from "./fixtures";

function record(): { sent: ClientMessage[]; send: (m: ClientMessage) => void } {
	const sent: ClientMessage[] = [];
	return { sent, send: (message) => sent.push(message) };
}

/** Every frame the overlay emits must survive the daemon's own parser. */
function only(sent: ClientMessage[]): ClientMessage {
	expect(sent).toHaveLength(1);
	const frame = sent[0];
	if (!frame) throw new Error("expected a frame");
	const parsed = parseClientMessage(JSON.parse(JSON.stringify(frame)));
	if (!parsed.ok)
		throw new Error(`daemon would reject the frame: ${parsed.error}`);
	return frame;
}

describe("PincerClient frames", () => {
	test("list_conversations", () => {
		const { sent, send } = record();
		daemon(send).listConversations();
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "list_conversations",
		});
	});

	test("new_conversation spreads the command-bar config", () => {
		const { sent, send } = record();
		daemon(send).newConversation({
			harnessId: "codex",
			model: "gpt-5",
			effort: "high",
		});
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "new_conversation",
			harnessId: "codex",
			model: "gpt-5",
			effort: "high",
		});
	});

	test("resume_conversation", () => {
		const { sent, send } = record();
		daemon(send).resumeConversation("c1");
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "resume_conversation",
			conversationId: "c1",
		});
	});

	test("set_config", () => {
		const { sent, send } = record();
		daemon(send).setConfig("c1", { model: "gpt-5" });
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "set_config",
			conversationId: "c1",
			model: "gpt-5",
		});
	});

	test("delete_conversation", () => {
		const { sent, send } = record();
		daemon(send).deleteConversation("c1");
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "delete_conversation",
			conversationId: "c1",
		});
	});

	test("prompt carries the selection payload", () => {
		const { sent, send } = record();
		daemon(send).prompt("c1", {
			prompt: "fix the header",
			source: { path: "src/Header.tsx", line: 12, column: 3 },
			domContext: domContext("header"),
			elements: [],
		});
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "prompt",
			conversationId: "c1",
			prompt: "fix the header",
			source: { path: "src/Header.tsx", line: 12, column: 3 },
			domContext: domContext("header"),
			elements: [],
		});
	});

	test("get_overlay_settings", () => {
		const { sent, send } = record();
		daemon(send).getOverlaySettings("/project", "http://localhost:5173");
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "get_overlay_settings",
			appRoot: "/project",
			appOrigin: "http://localhost:5173",
		});
	});

	test("updateShortcut sends only the shortcut field", () => {
		const { sent, send } = record();
		const shortcut = {
			code: "KeyK",
			alt: false,
			ctrl: false,
			shift: false,
			meta: true,
		};
		daemon(send).updateShortcut("/project", "http://localhost:5173", shortcut);
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "update_overlay_settings",
			appRoot: "/project",
			appOrigin: "http://localhost:5173",
			shortcut,
		});
	});

	test("updateFloatingButton sends only the toggle field", () => {
		const { sent, send } = record();
		daemon(send).updateFloatingButton(
			"/project",
			"http://localhost:5173",
			false,
		);
		expect(only(sent)).toEqual({
			v: PROTOCOL_VERSION,
			type: "update_overlay_settings",
			appRoot: "/project",
			appOrigin: "http://localhost:5173",
			showFloatingButton: false,
		});
	});

	test.each(["cancel", "revert", "accept", "discard"] as const)(
		"%s is a bare conversation command",
		(type) => {
			const { sent, send } = record();
			daemon(send)[type]("c1");
			expect(only(sent)).toEqual({
				v: PROTOCOL_VERSION,
				type,
				conversationId: "c1",
			});
		},
	);
});

test("each call builds a fresh client, so no stale send survives a reconnect", () => {
	const first = record();
	const second = record();
	let current = first.send;
	const listConversations = (): void => daemon(current).listConversations();

	listConversations();
	current = second.send;
	listConversations();

	expect(first.sent).toHaveLength(1);
	expect(second.sent).toHaveLength(1);
});
