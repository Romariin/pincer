import type {
	ClientMessage,
	ClientMessageType,
	ConversationConfig,
	ServerMessage,
} from "@pincer/core";
import type { Orchestrator } from "../orchestrator/orchestrator";
import type { Emit } from "../orchestrator/types";
import {
	applySettingsMessage,
	type SettingsRepository,
} from "./settingsMessages";

function conversationConfigFromMessage(
	msg: ConversationConfig,
): ConversationConfig {
	return {
		...(msg.harnessId === undefined ? {} : { harnessId: msg.harnessId }),
		...(msg.model === undefined ? {} : { model: msg.model }),
		...(msg.effort === undefined ? {} : { effort: msg.effort }),
	};
}

/** Errors carry back which request produced them; everything else passes through. */
function emitWithRequestContext(
	emit: Emit,
	response: ServerMessage,
	requestType: ClientMessageType,
	conversationId?: string,
): void {
	if (response.type !== "error") {
		emit(response);
		return;
	}
	emit({
		...response,
		requestType,
		conversationId: response.conversationId ?? conversationId,
	});
}

export async function handleClientMessage(
	orchestrator: Orchestrator,
	msg: ClientMessage,
	daemonProjectRoot: string,
	settings: SettingsRepository,
	emit: Emit,
): Promise<void> {
	switch (msg.type) {
		case "list_conversations":
			emit(orchestrator.listConversations());
			return;
		case "new_conversation":
			emitWithRequestContext(
				emit,
				await orchestrator.newConversation(conversationConfigFromMessage(msg)),
				msg.type,
			);
			return;
		case "resume_conversation":
			emitWithRequestContext(
				emit,
				orchestrator.resumeConversation(msg.conversationId),
				msg.type,
				msg.conversationId,
			);
			return;
		case "set_config":
			emitWithRequestContext(
				emit,
				orchestrator.setConfig(
					msg.conversationId,
					conversationConfigFromMessage(msg),
				),
				msg.type,
				msg.conversationId,
			);
			return;
		case "delete_conversation":
			emitWithRequestContext(
				emit,
				await orchestrator.deleteConversation(msg.conversationId),
				msg.type,
				msg.conversationId,
			);
			return;
		case "prompt": {
			const rejection = orchestrator.submitTurn(
				msg.conversationId,
				msg.prompt,
				msg.source,
				msg.domContext,
				msg.elements ?? [],
			);
			if (rejection)
				emitWithRequestContext(emit, rejection, msg.type, msg.conversationId);
			return;
		}
		case "cancel":
			await orchestrator.cancel(msg.conversationId);
			return;
		case "revert":
			emitWithRequestContext(
				emit,
				await orchestrator.revert(msg.conversationId),
				msg.type,
				msg.conversationId,
			);
			return;
		case "accept":
			emitWithRequestContext(
				emit,
				await orchestrator.accept(msg.conversationId),
				msg.type,
				msg.conversationId,
			);
			return;
		case "discard":
			emitWithRequestContext(
				emit,
				await orchestrator.discard(msg.conversationId),
				msg.type,
				msg.conversationId,
			);
			return;
		case "get_overlay_settings":
		case "update_overlay_settings":
			applySettingsMessage(msg, daemonProjectRoot, settings, emit);
			return;
	}
}
