import type { TurnState } from "@pincer/core";
import type { PincerStore } from "./storeTypes";
import type { Cfg } from "./thread";

/** In chat the conversation's own config wins; everywhere else it is the draft. */
export function activeCfg(state: PincerStore): Cfg {
	if (state.view === "chat" && state.conversationId) {
		const conversation = state.conversations.find(
			(item) => item.id === state.conversationId,
		);
		if (conversation)
			return {
				harnessId: conversation.harnessId,
				model: conversation.model,
				effort: conversation.effort,
			};
	}
	return { ...state.draft };
}

/** Turn state for the conversation currently presented in chat; hidden work never affects it. */
export function visibleTurnState(state: PincerStore): TurnState {
	if (state.view !== "chat" || !state.conversationId) return "idle";
	return (
		state.threads[state.conversationId]?.turnState ??
		state.conversations.find(
			(conversation) => conversation.id === state.conversationId,
		)?.turnState ??
		"idle"
	);
}
