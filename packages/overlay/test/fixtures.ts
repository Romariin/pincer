import type {
	ClientMessage,
	ConversationSummary,
	DomContext,
	HarnessDescriptor,
	LiveTurnSnapshot,
	MessageBlock,
	ServerMessage,
	TurnSummary,
} from "@pincer/core";
import { DEFAULT_TOGGLE_SHORTCUT, PROTOCOL_VERSION } from "@pincer/core";
import { usePincerStore } from "../src/state/store";
import type { PendingPrompt } from "../src/state/storeTypes";
import type { ConversationThread } from "../src/state/thread";

export function conversation(
	id: string,
	turnState: ConversationSummary["turnState"] = "idle",
	queuePosition: number | null = null,
): ConversationSummary {
	return {
		id,
		branch: `pincer/${id}`,
		status: "active",
		createdAt: 1,
		updatedAt: 2,
		turnCount: 0,
		title: `${id} title`,
		harnessId: "codex",
		model: "gpt-5",
		effort: "high",
		turnState,
		queuePosition,
	};
}

export function liveTurn(
	conversationId: string,
	overrides: Partial<LiveTurnSnapshot> = {},
): LiveTurnSnapshot {
	return {
		conversationId,
		turnId: 1,
		seq: 0,
		state: "running",
		queuePosition: null,
		prompt: `${conversationId} prompt`,
		blocks: [],
		selection: { harnessId: "codex", model: "gpt-5", effort: "high" },
		...overrides,
	};
}

export function turn(
	seq: number,
	prompt: string,
	blocks: MessageBlock[],
): TurnSummary {
	return {
		id: seq + 1,
		seq,
		prompt,
		checkpoint: `checkpoint-${seq}`,
		status: "complete",
		createdAt: seq + 1,
		output: blocks
			.filter(
				(block): block is Extract<MessageBlock, { t: "md" }> =>
					block.t === "md",
			)
			.map((block) => block.text)
			.join(""),
		blocks,
	};
}

export function harness(
	id: string,
	overrides: Partial<HarnessDescriptor> = {},
): HarnessDescriptor {
	return {
		id,
		label: id,
		glyph: ">_",
		c1: "#111111",
		c2: "#222222",
		detected: true,
		capabilities: { model: true, effort: true, resume: true },
		catalog: { status: "ready", diagnostics: [] },
		models: [{ id: "gpt-5", label: "GPT-5", efforts: ["low", "high"] }],
		...overrides,
	};
}

export function domContext(tag = "div"): DomContext {
	return { tag, id: null, classes: [], text: null, ancestry: [] };
}

export function pendingPrompt(prompt: string, elementCount = 0): PendingPrompt {
	return {
		prompt,
		source: null,
		domContext: domContext(),
		elements: Array.from({ length: elementCount }, () => ({
			source: null,
			domContext: domContext("span"),
		})),
	};
}

export const welcome = (
	harnesses: HarnessDescriptor[] = [],
): ServerMessage => ({
	v: PROTOCOL_VERSION,
	type: "welcome",
	daemonVersion: "test",
	protocolVersion: PROTOCOL_VERSION,
	projectRoot: "/project",
	harnesses,
	defaultHarnessId: harnesses[0]?.id ?? null,
});

export function resetStore(): void {
	usePincerStore.setState({
		connected: false,
		view: "list",
		panelOpen: false,
		resizingPanel: false,
		selecting: false,
		picker: null,
		referenceCopyStatus: "idle",
		shortcut: DEFAULT_TOGGLE_SHORTCUT,
		showFloatingButton: true,
		appRoot: null,
		appOrigin: null,
		settingsLoaded: false,
		settingsPending: false,
		settingsError: null,
		recordingShortcut: false,
		harnesses: [],
		harnessMap: {},
		draft: { harnessId: "", model: "", effort: "High" },
		conversations: [],
		conversationId: null,
		threads: {},
		pendingPrompt: null,
		configPending: {},
		selections: [],
		send: () => {},
	});
}

/** Replaces `send` with a recorder and returns the frames it collects. */
export function recordSentFrames(): ClientMessage[] {
	const sent: ClientMessage[] = [];
	usePincerStore.setState({ send: (message) => sent.push(message) });
	return sent;
}

export const apply = (message: ServerMessage): void =>
	usePincerStore.getState().applyServerMessage(message);

export function resume(
	summary: ConversationSummary,
	turns: TurnSummary[] = [],
	current: LiveTurnSnapshot | null = null,
): void {
	apply({
		v: PROTOCOL_VERSION,
		type: "conversation_resumed",
		conversation: summary,
		turns,
		liveTurn: current,
	});
}

export function requireThread(conversationId: string): ConversationThread {
	const thread = usePincerStore.getState().threads[conversationId];
	if (!thread) throw new Error(`expected thread ${conversationId}`);
	return thread;
}

export function content(conversationId: string): Array<{
	role: "user" | "assistant" | "system";
	blocks: MessageBlock[];
}> {
	return requireThread(conversationId).messages.map(({ role, blocks }) => ({
		role,
		blocks,
	}));
}
