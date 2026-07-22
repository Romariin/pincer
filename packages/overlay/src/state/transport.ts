import { PROTOCOL_VERSION } from "@pincer/core";
import type {
	ClientMessage,
	ConversationConfig,
	KeyboardShortcut,
} from "@pincer/core";

export type SendFrame = (message: ClientMessage) => void;

export class PincerClient {
	constructor(private readonly sendFrame: SendFrame) {}

	listConversations(): void {
		this.sendFrame({ v: PROTOCOL_VERSION, type: "list_conversations" });
	}

	newConversation(config: ConversationConfig): void {
		this.sendFrame({ v: PROTOCOL_VERSION, type: "new_conversation", ...config });
	}

	resumeConversation(conversationId: string): void {
		this.sendFrame({ v: PROTOCOL_VERSION, type: "resume_conversation", conversationId });
	}

	setConfig(conversationId: string, config: ConversationConfig): void {
		this.sendFrame({ v: PROTOCOL_VERSION, type: "set_config", conversationId, ...config });
	}

	deleteConversation(conversationId: string): void {
		this.sendFrame({ v: PROTOCOL_VERSION, type: "delete_conversation", conversationId });
	}

	prompt(
		conversationId: string,
		payload: Omit<Extract<ClientMessage, { type: "prompt" }>, "v" | "type" | "conversationId">,
	): void {
		this.sendFrame({ v: PROTOCOL_VERSION, type: "prompt", conversationId, ...payload });
	}

	getOverlaySettings(appRoot: string, appOrigin: string): void {
		this.sendFrame({
			v: PROTOCOL_VERSION,
			type: "get_overlay_settings",
			appRoot,
			appOrigin,
		});
	}

	updateShortcut(appRoot: string, appOrigin: string, shortcut: KeyboardShortcut): void {
		this.sendFrame({
			v: PROTOCOL_VERSION,
			type: "update_overlay_settings",
			appRoot,
			appOrigin,
			shortcut,
		});
	}

	updateFloatingButton(appRoot: string, appOrigin: string, showFloatingButton: boolean): void {
		this.sendFrame({
			v: PROTOCOL_VERSION,
			type: "update_overlay_settings",
			appRoot,
			appOrigin,
			showFloatingButton,
		});
	}

	cancel(conversationId: string): void {
		this.sendConversationCommand("cancel", conversationId);
	}

	revert(conversationId: string): void {
		this.sendConversationCommand("revert", conversationId);
	}

	accept(conversationId: string): void {
		this.sendConversationCommand("accept", conversationId);
	}

	discard(conversationId: string): void {
		this.sendConversationCommand("discard", conversationId);
	}

	private sendConversationCommand(
		type: "cancel" | "revert" | "accept" | "discard",
		conversationId: string,
	): void {
		this.sendFrame({ v: PROTOCOL_VERSION, type, conversationId });
	}
}
