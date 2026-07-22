import type {
	ConversationSummary,
	LiveTurnSnapshot,
	MessageBlock,
	TurnState,
} from "@pincer/core";

export interface Cfg {
	harnessId: string;
	model: string;
	effort: string;
}

export interface Msg {
	id: number;
	role: "user" | "assistant" | "system";
	blocks: MessageBlock[];
	/** Command-bar config captured when an assistant turn began. */
	meta?: Cfg;
	elementCount?: number;
}

export interface ConversationThread {
	messages: Msg[];
	streamingIndex: number | null;
	turnState: TurnState;
	queuePosition: number | null;
	turnId: number | null;
	liveTurnSeq: number | null;
}

let nextMessageId = 0;

function createMessageId(): number {
	nextMessageId += 1;
	return nextMessageId;
}

export function userMsg(text: string, count: number): Msg {
	return {
		id: createMessageId(),
		role: "user",
		blocks: [{ t: "md", text }],
		elementCount: count,
	};
}

export function assistantMsg(blocks: MessageBlock[], meta?: Cfg): Msg {
	return { id: createMessageId(), role: "assistant", blocks, meta };
}

export function emptyThread(): ConversationThread {
	return {
		messages: [],
		streamingIndex: null,
		turnState: "idle",
		queuePosition: null,
		turnId: null,
		liveTurnSeq: null,
	};
}

export function conversationCfg(conversation: ConversationSummary): Cfg {
	return {
		harnessId: conversation.harnessId,
		model: conversation.model,
		effort: conversation.effort,
	};
}

export function upsertConversation(
	conversations: ConversationSummary[],
	conversation: ConversationSummary,
): ConversationSummary[] {
	return [conversation, ...conversations.filter((item) => item.id !== conversation.id)];
}

export function replaceConversation(
	conversations: ConversationSummary[],
	conversation: ConversationSummary,
): ConversationSummary[] {
	if (!conversations.some((item) => item.id === conversation.id)) {
		return [conversation, ...conversations];
	}
	return conversations.map((item) =>
		item.id === conversation.id ? conversation : item,
	);
}

export function updateConversationTurnState(
	conversations: ConversationSummary[],
	conversationId: string,
	turnState: TurnState,
	queuePosition: number | null,
): ConversationSummary[] {
	return conversations.map((conversation) =>
		conversation.id === conversationId
			? { ...conversation, turnState, queuePosition }
			: conversation,
	);
}

export function mergeLiveTurn(
	thread: ConversationThread,
	liveTurn: LiveTurnSnapshot,
): ConversationThread {
	let messages = thread.messages;
	const last = messages[messages.length - 1];
	const sameLiveTurn =
		thread.turnState !== "idle" &&
		((liveTurn.seq !== null && thread.liveTurnSeq === liveTurn.seq) ||
			(thread.turnState === "queued" &&
				thread.turnId === null &&
				last?.role === "user" &&
				last.blocks[0]?.t === "md" &&
				last.blocks[0].text === liveTurn.prompt));

	if (!sameLiveTurn) messages = [...messages, userMsg(liveTurn.prompt, 0)];

	let streamingIndex: number | null = null;
	if (liveTurn.state === "running") {
		const meta: Cfg = { ...liveTurn.selection };
		if (sameLiveTurn && thread.streamingIndex !== null) {
			streamingIndex = thread.streamingIndex;
			messages = messages.map((message, index) =>
				index === streamingIndex
					? { ...message, blocks: liveTurn.blocks, meta }
					: message,
			);
		} else {
			streamingIndex = messages.length;
			messages = [...messages, assistantMsg(liveTurn.blocks, meta)];
		}
	}

	return {
		messages,
		streamingIndex,
		turnState: liveTurn.state,
		queuePosition: liveTurn.queuePosition,
		turnId: liveTurn.turnId,
		liveTurnSeq: liveTurn.seq,
	};
}

export function finishThread(thread: ConversationThread): ConversationThread {
	const index = thread.streamingIndex;
	let messages = thread.messages;
	const current = index === null ? undefined : messages[index];
	if (current?.role === "assistant" && current.blocks.length === 0) {
		messages = messages.filter((_, messageIndex) => messageIndex !== index);
	}
	return {
		messages,
		streamingIndex: null,
		turnState: "idle",
		queuePosition: null,
		turnId: null,
		liveTurnSeq: null,
	};
}

export function withSystemNote(
	thread: ConversationThread,
	text: string,
): ConversationThread {
	return {
		...thread,
		messages: [
			...thread.messages,
			{ id: createMessageId(), role: "system", blocks: [{ t: "md", text }] },
		],
	};
}