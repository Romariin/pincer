import { visibleTurnState } from "./selectors";
import type { PincerStore } from "./storeTypes";
import { emptyThread, updateConversationTurnState, userMsg } from "./thread";
import { daemon } from "./transport";

type Set = (
	partial:
		| Partial<PincerStore>
		| ((state: PincerStore) => Partial<PincerStore> | PincerStore),
) => void;
type Get = () => PincerStore;

export function conversationActions(
	set: Set,
	get: Get,
): Pick<
	PincerStore,
	| "queueUserMessage"
	| "setPendingPrompt"
	| "openConversation"
	| "deleteConversation"
	| "submitPrompt"
	| "cancelVisibleTurn"
> {
	return {
		queueUserMessage: (conversationId, text, count) =>
			set((state) => {
				const current = state.threads[conversationId] ?? emptyThread();
				if (current.turnState !== "idle") return state;
				return {
					threads: {
						...state.threads,
						[conversationId]: {
							...current,
							messages: [...current.messages, userMsg(text, count)],
							streamingIndex: null,
							turnState: "queued",
							queuePosition: null,
							turnId: null,
							liveTurnSeq: null,
						},
					},
					conversations: updateConversationTurnState(
						state.conversations,
						conversationId,
						"queued",
						null,
					),
				};
			}),
		setPendingPrompt: (pendingPrompt) => set({ pendingPrompt }),
		openConversation: (conversationId) => {
			const state = get();
			if (!state.connected) return;
			daemon(state.send).resumeConversation(conversationId);
		},
		deleteConversation: (conversationId) => {
			const state = get();
			if (!state.connected) return;
			daemon(state.send).deleteConversation(conversationId);
		},
		submitPrompt: (payload) => {
			const state = get();
			if (
				!state.connected ||
				state.pendingPrompt !== null ||
				visibleTurnState(state) !== "idle"
			)
				return;
			if (state.view === "chat" && state.conversationId) {
				state.queueUserMessage(
					state.conversationId,
					payload.prompt,
					payload.elements.length,
				);
				daemon(state.send).prompt(state.conversationId, payload);
				return;
			}
			set({ pendingPrompt: payload });
			daemon(state.send).newConversation(state.draft);
		},
		cancelVisibleTurn: () => {
			const state = get();
			if (
				!state.connected ||
				state.view !== "chat" ||
				!state.conversationId ||
				visibleTurnState(state) === "idle"
			) {
				return;
			}
			daemon(state.send).cancel(state.conversationId);
		},
	};
}
