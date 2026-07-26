import type { HarnessDescriptor } from "@pincer/core";
import type { PincerStore } from "./storeTypes";
import {
	assistantMsg,
	type ConversationThread,
	conversationCfg,
	emptyThread,
	finishThread,
	type Msg,
	mergeLiveTurn,
	replaceConversation,
	updateConversationTurnState,
	upsertConversation,
	userMsg,
	withSystemNote,
} from "./thread";
import { daemon } from "./transport";
import { turnMessageActions } from "./turnMessages";

type Set = (
	partial:
		| Partial<PincerStore>
		| ((state: PincerStore) => Partial<PincerStore> | PincerStore),
) => void;
type Get = () => PincerStore;

function clearConfigPending(
	pending: Record<string, boolean>,
	conversationId: string,
): Record<string, boolean> {
	if (!pending[conversationId]) return pending;
	const next = { ...pending };
	delete next[conversationId];
	return next;
}

export function serverMessageActions(
	set: Set,
	get: Get,
): Pick<PincerStore, "applyServerMessage"> {
	const refreshConversations = (): void => {
		daemon(get().send).listConversations();
	};

	const { mergeTurn, streamHarnessEvent, settleTurn } = turnMessageActions(
		set,
		refreshConversations,
	);

	const appendSystemNote = (conversationId: string, text: string): void => {
		set((current) => {
			const thread = current.threads[conversationId] ?? emptyThread();
			return {
				threads: {
					...current.threads,
					[conversationId]: withSystemNote(thread, text),
				},
			};
		});
	};

	const appendSystemNoteToVisible = (text: string): void => {
		const state = get();
		if (state.view !== "chat" || !state.conversationId) return;
		appendSystemNote(state.conversationId, text);
	};

	return {
		applyServerMessage: (message) => {
			const state = get();
			switch (message.type) {
				case "welcome": {
					const harnessMap: Record<string, HarnessDescriptor> = {};
					for (const harness of message.harnesses)
						harnessMap[harness.id] = harness;
					const defaultHarnessId = message.defaultHarnessId ?? "";
					const retained =
						defaultHarnessId.length > 0
							? harnessMap[state.draft.harnessId]
							: undefined;
					const retainDraft = retained?.detected === true;
					const harnessId = retainDraft
						? state.draft.harnessId
						: defaultHarnessId;
					const model = retainDraft ? state.draft.model : "";
					const effort = retainDraft ? state.draft.effort : "";
					set({
						harnesses: message.harnesses,
						harnessMap,
						draft: { harnessId, model, effort },
					});
					break;
				}
				case "overlay_settings":
					if (message.settings.appOrigin !== state.appOrigin) break;
					set({
						appRoot: message.settings.appRoot,
						appOrigin: message.settings.appOrigin,
						shortcut: message.settings.shortcut,
						showFloatingButton: message.settings.showFloatingButton,
						settingsLoaded: true,
						settingsPending: false,
						settingsError: null,
						recordingShortcut: false,
					});
					break;
				case "conversations":
					set({ conversations: message.items });
					break;
				case "conversation_started": {
					const conversationId = message.conversation.id;
					const pending = state.pendingPrompt;
					let thread = state.threads[conversationId] ?? emptyThread();
					if (pending && thread.turnState === "idle") {
						thread = {
							...thread,
							messages: [
								...thread.messages,
								userMsg(pending.prompt, pending.elements.length),
							],
							turnState: "queued",
						};
					}
					set({
						conversationId,
						conversations: upsertConversation(state.conversations, {
							...message.conversation,
							turnState: pending ? "queued" : message.conversation.turnState,
							queuePosition: pending
								? null
								: message.conversation.queuePosition,
						}),
						threads: { ...state.threads, [conversationId]: thread },
						pendingPrompt: null,
						view: "chat",
						recordingShortcut: false,
					});
					if (pending) daemon(state.send).prompt(conversationId, pending);
					break;
				}
				case "conversation_resumed": {
					const conversationId = message.conversation.id;
					const cfg = conversationCfg(message.conversation);
					const messages: Msg[] = [];
					for (const turn of message.turns) {
						if (
							message.liveTurn?.seq !== null &&
							turn.seq === message.liveTurn?.seq
						)
							continue;
						messages.push(userMsg(turn.prompt, 0));
						if (turn.blocks.length)
							messages.push(assistantMsg(turn.blocks, cfg));
					}
					let thread: ConversationThread = { ...emptyThread(), messages };
					if (message.liveTurn)
						thread = mergeLiveTurn(thread, message.liveTurn);
					set({
						conversationId,
						conversations: replaceConversation(
							state.conversations,
							message.conversation,
						),
						threads: { ...state.threads, [conversationId]: thread },
						view: "chat",
						recordingShortcut: false,
					});
					break;
				}
				case "config_updated":
					set({
						conversations: replaceConversation(
							state.conversations,
							message.conversation,
						),
						configPending: clearConfigPending(
							state.configPending,
							message.conversation.id,
						),
					});
					break;
				case "deleted":
					set((current) => {
						const threads = { ...current.threads };
						delete threads[message.conversationId];
						const visible = current.conversationId === message.conversationId;
						return {
							conversations: current.conversations.filter(
								(conversation) => conversation.id !== message.conversationId,
							),
							threads,
							conversationId: visible ? null : current.conversationId,
							view: visible ? "list" : current.view,
							recordingShortcut: visible ? false : current.recordingShortcut,
						};
					});
					break;
				case "blocked": {
					const conversationId =
						message.conversationId ??
						(state.view === "chat" ? state.conversationId : null);
					if (conversationId) {
						set((current) => {
							const currentThread =
								current.threads[conversationId] ?? emptyThread();
							const outstanding = message.reason === "outstanding_turn";
							const thread = outstanding
								? currentThread
								: finishThread(currentThread);
							return {
								threads: {
									...current.threads,
									[conversationId]: withSystemNote(thread, message.message),
								},
								conversations: outstanding
									? current.conversations
									: updateConversationTurnState(
											current.conversations,
											conversationId,
											"idle",
											null,
										),
								pendingPrompt: message.conversationId
									? current.pendingPrompt
									: null,
								configPending: clearConfigPending(
									current.configPending,
									conversationId,
								),
							};
						});
					} else {
						set({ pendingPrompt: null });
					}
					break;
				}
				case "turn_queued":
					mergeTurn(
						message.conversationId,
						message.liveTurn,
						"queued",
						message.liveTurn.queuePosition,
					);
					break;
				case "turn_started":
					mergeTurn(message.conversationId, message.liveTurn, "running", null);
					break;
				case "harness_output":
					streamHarnessEvent(
						message.conversationId,
						message.turnId,
						message.event,
					);
					break;
				case "turn_complete":
					settleTurn(
						message.conversationId,
						(thread) => thread.turnId === message.turnId,
					);
					break;
				case "turn_error":
					settleTurn(
						message.conversationId,
						(thread) =>
							thread.turnState !== "idle" &&
							message.turnId !== null &&
							thread.turnId === message.turnId,
						`Error: ${message.message}`,
					);
					break;
				case "turn_cancelled":
					settleTurn(
						message.conversationId,
						(thread) =>
							thread.turnId === message.turnId ||
							(thread.turnState === "queued" && thread.turnId === null),
					);
					break;
				case "accepted":
				case "discarded": {
					const visible = state.conversationId === message.conversationId;
					if (visible)
						set({
							conversationId: null,
							view: "list",
							recordingShortcut: false,
						});
					refreshConversations();
					break;
				}
				case "reverted":
					refreshConversations();
					break;
				case "error": {
					if (
						!message.conversationId &&
						message.requestType === "new_conversation"
					) {
						set({ pendingPrompt: null });
					}
					if (message.conversationId && message.requestType === "set_config") {
						set({
							configPending: clearConfigPending(
								state.configPending,
								message.conversationId,
							),
						});
					}
					if (message.conversationId && message.requestType === "prompt") {
						settleTurn(message.conversationId, () => true);
					}
					const settingsRequestActive =
						state.settingsPending ||
						(!state.settingsLoaded &&
							state.connected &&
							state.appRoot !== null &&
							state.appOrigin !== null);
					if (
						message.code === "settings_unavailable" ||
						(message.code === "bad_message" && settingsRequestActive)
					) {
						set({
							settingsPending: false,
							settingsError: message.message,
							recordingShortcut: false,
						});
					} else if (message.conversationId) {
						appendSystemNote(message.conversationId, message.message);
					} else {
						appendSystemNoteToVisible(message.message);
					}
					break;
				}
			}
		},
	};
}
