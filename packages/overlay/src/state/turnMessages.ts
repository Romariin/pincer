import type {
	HarnessEvent,
	LiveTurnSnapshot,
	MessageBlock,
} from "@pincer/core";
import type { PincerStore } from "./storeTypes";
import {
	type ConversationThread,
	conversationCfg,
	emptyThread,
	finishThread,
	mergeLiveTurn,
	streamIntoThread,
	updateConversationTurnState,
	withSystemNote,
} from "./thread";

type Set = (
	partial:
		| Partial<PincerStore>
		| ((state: PincerStore) => Partial<PincerStore> | PincerStore),
) => void;

export interface TurnMessageActions {
	/** Merges a live-turn snapshot into the thread and mirrors it on the list row. */
	mergeTurn(
		conversationId: string,
		liveTurn: LiveTurnSnapshot,
		turnState: "queued" | "running",
		queuePosition: number | null,
	): void;
	streamHarnessEvent(
		conversationId: string,
		turnId: number,
		event: HarnessEvent,
	): void;
	/**
	 * Ends a turn: the thread stops streaming and the conversation goes idle.
	 * `accept` decides whether the frame still refers to the thread's own turn,
	 * since a late frame from a superseded turn must be ignored.
	 */
	settleTurn(
		conversationId: string,
		accept: (thread: ConversationThread) => boolean,
		note?: string,
	): void;
}

export function turnMessageActions(
	set: Set,
	refreshConversations: () => void,
): TurnMessageActions {
	const stream = (
		conversationId: string,
		turnId: number,
		apply: (blocks: MessageBlock[]) => MessageBlock[],
	): void => {
		set((state) => {
			const conversation = state.conversations.find(
				(item) => item.id === conversationId,
			);
			const next = streamIntoThread(
				state.threads[conversationId] ?? emptyThread(),
				turnId,
				conversation ? conversationCfg(conversation) : undefined,
				apply,
			);
			if (!next) return state;
			return { threads: { ...state.threads, [conversationId]: next } };
		});
	};

	const appendBlock = (
		conversationId: string,
		turnId: number,
		block: MessageBlock,
	): void => {
		stream(conversationId, turnId, (blocks) => [...blocks, block]);
	};

	return {
		mergeTurn: (conversationId, liveTurn, turnState, queuePosition) => {
			set((current) => {
				const thread = current.threads[conversationId] ?? emptyThread();
				const next = mergeLiveTurn(thread, liveTurn);
				if (next === thread) return current;
				return {
					threads: { ...current.threads, [conversationId]: next },
					conversations: updateConversationTurnState(
						current.conversations,
						conversationId,
						turnState,
						queuePosition,
					),
				};
			});
		},

		streamHarnessEvent: (conversationId, turnId, event) => {
			if (event.kind === "text") {
				stream(conversationId, turnId, (blocks) => {
					const next = [...blocks];
					const last = next[next.length - 1];
					if (last?.t === "md")
						next[next.length - 1] = { t: "md", text: last.text + event.text };
					else next.push({ t: "md", text: event.text });
					return next;
				});
			} else if (event.kind === "tool") {
				appendBlock(conversationId, turnId, {
					t: "tool",
					name: event.name,
					detail: event.detail,
				});
			} else if (event.kind === "diff") {
				appendBlock(conversationId, turnId, {
					t: "diff",
					file: event.file,
					hunks: event.hunks,
				});
			}
		},

		settleTurn: (conversationId, accept, note) => {
			set((current) => {
				const thread = current.threads[conversationId] ?? emptyThread();
				if (!accept(thread)) return current;
				const finished = finishThread(thread);
				return {
					threads: {
						...current.threads,
						[conversationId]: note ? withSystemNote(finished, note) : finished,
					},
					conversations: updateConversationTurnState(
						current.conversations,
						conversationId,
						"idle",
						null,
					),
				};
			});
			refreshConversations();
		},
	};
}
