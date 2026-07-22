import { expect, test } from "bun:test";
import { LiveTurnBuffer } from "../src/liveTurnBuffer";

test("live turn buffering coalesces text and bounds protocol snapshots", () => {
	const buffer = new LiveTurnBuffer({
		conversationId: "conversation",
		prompt: "prompt",
		selection: { harnessId: "omp", model: "model", effort: "" },
		maxTextChars: 5,
		maxBlocks: 2,
	});

	expect(buffer.record({ kind: "text", text: "abc" })).toEqual({
		kind: "text",
		text: "abc",
	});
	expect(buffer.record({ kind: "text", text: "def" })).toEqual({
		kind: "text",
		text: "de\n\n[Live output truncated]",
	});
	expect(buffer.record({ kind: "text", text: "ignored" })).toBeNull();
	expect(buffer.snapshot().blocks).toEqual([
		{ t: "md", text: "abcde\n\n[Live output truncated]" },
	]);
});
