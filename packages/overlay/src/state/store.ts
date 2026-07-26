import type {
	ClientMessage,
	ConversationSummary,
	DomContext,
	HarnessDescriptor,
	KeyboardShortcut,
	MessageBlock,
	PromptElement,
	ServerMessage,
	SourceLocation,
	TurnState,
} from "@pincer/core";
import { DEFAULT_TOGGLE_SHORTCUT } from "@pincer/core";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { buildDomContext, resolveSource } from "@/dom/picker";
import { harnessInfo } from "@/lib/harness";
import { clampPanelWidth, loadPanelWidth, savePanelWidth } from "@/lib/panelWidth";
import {
	assistantMsg,
	type Cfg,
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
import { PincerClient } from "./transport";

export type { Cfg, ConversationThread, Msg } from "./thread";

export type View = "list" | "chat" | "settings";
export type PickerKind = "harness" | "model" | "effort";
export type ReferenceCopyStatus = "idle" | "selecting" | "copied" | "error";

export interface Selection {
	id: number;
	domEl: HTMLElement;
	source: SourceLocation | null;
	domContext: DomContext;
}

export interface PendingPrompt {
	prompt: string;
	source: SourceLocation | null;
	domContext: DomContext;
	elements: PromptElement[];
}

let nextSelectionId = 0;
let referenceCopyResetVersion = 0;

function client(send: (message: ClientMessage) => void): PincerClient {
	return new PincerClient(send);
}

function withoutPending(
	pending: Record<string, boolean>,
	conversationId: string,
): Record<string, boolean> {
	if (!pending[conversationId]) return pending;
	const next = { ...pending };
	delete next[conversationId];
	return next;
}

export interface PincerStore {
	// ---- connection / view ----
	connected: boolean;
	view: View;
	panelOpen: boolean;
	panelWidth: number;
	resizingPanel: boolean;
	selecting: boolean;
	picker: PickerKind | null;
	referenceCopyStatus: ReferenceCopyStatus;

	// ---- durable overlay settings ----
	shortcut: KeyboardShortcut;
	showFloatingButton: boolean;
	appRoot: string | null;
	appOrigin: string | null;
	settingsLoaded: boolean;
	settingsPending: boolean;
	settingsError: string | null;
	recordingShortcut: boolean;

	// ---- harness catalog ----
	harnesses: HarnessDescriptor[];
	harnessMap: Record<string, HarnessDescriptor>;
	draft: Cfg;

	// ---- conversations / thread ----
	conversations: ConversationSummary[];
	conversationId: string | null;
	threads: Record<string, ConversationThread>;
	pendingPrompt: PendingPrompt | null;
	configPending: Record<string, boolean>;

	// ---- element selections ----
	selections: Selection[];

	// ---- socket ----
	send: (msg: ClientMessage) => void;
	setSend: (fn: (msg: ClientMessage) => void) => void;
	setConnected: (c: boolean) => void;

	// ---- UI ops ----
	setPanelOpen: (open: boolean) => void;
	setPanelWidth: (width: number) => void;
	setResizingPanel: (resizing: boolean) => void;
	setView: (view: View) => void;
	openPicker: (kind: PickerKind) => void;
	openSettings: () => void;
	closePicker: () => void;
	setSelecting: (on: boolean) => void;
	startCopyingReference: () => void;
	finishCopyingReference: (status: "copied" | "error") => void;
	prepareSettings: (
		appRoot: string | null,
		appOrigin: string | null,
		error: string | null,
	) => void;
	startRecordingShortcut: () => void;
	cancelRecordingShortcut: () => void;
	updateShortcut: (shortcut: KeyboardShortcut) => void;
	updateShowFloatingButton: (show: boolean) => void;

	// ---- config ----
	updateCfg: (patch: Partial<Cfg>) => void;
	choose: (kind: PickerKind, val: string) => void;

	// ---- selections ----
	toggleSelect: (node: HTMLElement) => void;
	removeSelection: (domEl: HTMLElement) => void;
	clearSelections: () => void;

	// ---- thread ----
	queueUserMessage: (
		conversationId: string,
		text: string,
		count: number,
	) => void;
	setPendingPrompt: (p: PendingPrompt | null) => void;
	openConversation: (conversationId: string) => void;
	deleteConversation: (conversationId: string) => void;
	submitPrompt: (payload: PendingPrompt) => void;
	cancelVisibleTurn: () => void;

	// ---- protocol ----
	applyServerMessage: (msg: ServerMessage) => void;
}

/** Resolve the active command-bar config: the conversation's in chat view, else the draft. */
export function computeCfg(s: PincerStore): Cfg {
	if (s.view === "chat" && s.conversationId) {
		const c = s.conversations.find((x) => x.id === s.conversationId);
		if (c) return { harnessId: c.harnessId, model: c.model, effort: c.effort };
	}
	return { ...s.draft };
}

export const usePincerStore = create<PincerStore>()((set, get) => {
	const appendText = (
		conversationId: string,
		turnId: number,
		delta: string,
	): void => {
		set((state) => {
			const current = state.threads[conversationId] ?? emptyThread();
			if (current.turnState !== "running" || current.turnId !== turnId)
				return state;

			let streamingIndex = current.streamingIndex;
			let messages = current.messages;
			if (streamingIndex === null) {
				const conversation = state.conversations.find(
					(item) => item.id === conversationId,
				);
				const meta = conversation ? conversationCfg(conversation) : undefined;
				streamingIndex = messages.length;
				messages = [...messages, assistantMsg([], meta)];
			}
			messages = messages.map((message, index) => {
				if (index !== streamingIndex) return message;
				const blocks = [...message.blocks];
				const last = blocks[blocks.length - 1];
				if (last?.t === "md")
					blocks[blocks.length - 1] = { t: "md", text: last.text + delta };
				else blocks.push({ t: "md", text: delta });
				return { ...message, blocks };
			});

			return {
				threads: {
					...state.threads,
					[conversationId]: {
						...current,
						messages,
						streamingIndex,
						turnState: "running",
						queuePosition: null,
						turnId,
					},
				},
			};
		});
	};

	const addBlock = (
		conversationId: string,
		turnId: number,
		block: MessageBlock,
	): void => {
		set((state) => {
			const current = state.threads[conversationId] ?? emptyThread();
			if (current.turnState !== "running" || current.turnId !== turnId)
				return state;

			let streamingIndex = current.streamingIndex;
			let messages = current.messages;
			if (streamingIndex === null) {
				const conversation = state.conversations.find(
					(item) => item.id === conversationId,
				);
				const meta = conversation ? conversationCfg(conversation) : undefined;
				streamingIndex = messages.length;
				messages = [...messages, assistantMsg([], meta)];
			}
			messages = messages.map((message, index) =>
				index === streamingIndex
					? { ...message, blocks: [...message.blocks, block] }
					: message,
			);

			return {
				threads: {
					...state.threads,
					[conversationId]: {
						...current,
						messages,
						streamingIndex,
						turnState: "running",
						queuePosition: null,
						turnId,
					},
				},
			};
		});
	};

	const noteConversation = (conversationId: string, text: string): void => {
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

	const noteVisibleConversation = (text: string): void => {
		const state = get();
		if (state.view !== "chat" || !state.conversationId) return;
		noteConversation(state.conversationId, text);
	};

	return {
		connected: false,
		view: "list",
		panelOpen: false,
		panelWidth: loadPanelWidth(),
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
		setSend: (fn) => set({ send: fn }),
		setConnected: (connected) =>
			set(
				connected
					? { connected: true }
					: {
							connected: false,
							settingsLoaded: false,
							settingsPending: false,
							recordingShortcut: false,
							configPending: {},
							pendingPrompt: null,
						},
			),

		setPanelOpen: (open) => {
			if (open === get().panelOpen) return;
			if (open) {
				set({ panelOpen: true, view: "list", recordingShortcut: false });
				client(get().send).listConversations();
			} else {
				set({
					panelOpen: false,
					selecting: false,
					referenceCopyStatus: "idle",
					picker: null,
					recordingShortcut: false,
				});
			}
		},
		setPanelWidth: (width) => {
			const panelWidth = clampPanelWidth(width);
			if (panelWidth === get().panelWidth) return;
			set({ panelWidth });
			savePanelWidth(panelWidth);
		},
		setResizingPanel: (resizingPanel) => set({ resizingPanel }),
		setView: (view) =>
			set((state) => ({
				view,
				recordingShortcut:
					view === "settings" ? state.recordingShortcut : false,
			})),
		openSettings: () =>
			set({
				view: "settings",
				picker: null,
				selecting: false,
				referenceCopyStatus: "idle",
				recordingShortcut: false,
			}),
		openPicker: (kind) => set({ picker: kind }),
		closePicker: () => set({ picker: null }),
		setSelecting: (on) => {
			referenceCopyResetVersion += 1;
			set({ selecting: on, referenceCopyStatus: "idle" });
		},
		startCopyingReference: () => {
			referenceCopyResetVersion += 1;
			set({ selecting: true, referenceCopyStatus: "selecting" });
		},
		finishCopyingReference: (status) => {
			set({ selecting: false, referenceCopyStatus: status });
			referenceCopyResetVersion += 1;
			const resetVersion = referenceCopyResetVersion;
			setTimeout(() => {
				if (
					referenceCopyResetVersion === resetVersion &&
					get().referenceCopyStatus === status
				) {
					set({ referenceCopyStatus: "idle" });
				}
			}, 1600);
		},
		prepareSettings: (appRoot, appOrigin, error) =>
			set({
				appRoot,
				appOrigin,
				settingsLoaded: false,
				settingsPending: false,
				settingsError: error,
				recordingShortcut: false,
			}),
		startRecordingShortcut: () => {
			const state = get();
			if (
				!state.connected ||
				!state.settingsLoaded ||
				state.settingsPending ||
				!state.appRoot ||
				!state.appOrigin
			) {
				return;
			}
			set({ recordingShortcut: true, settingsError: null });
		},
		cancelRecordingShortcut: () => set({ recordingShortcut: false }),
		updateShortcut: (shortcut) => {
			const state = get();
			if (
				!state.connected ||
				!state.settingsLoaded ||
				state.settingsPending ||
				!state.appRoot ||
				!state.appOrigin
			) {
				return;
			}
			set({
				settingsPending: true,
				settingsError: null,
				recordingShortcut: false,
			});
			client(state.send).updateShortcut(
				state.appRoot,
				state.appOrigin,
				shortcut,
			);
		},
		updateShowFloatingButton: (showFloatingButton) => {
			const state = get();
			if (
				!state.connected ||
				!state.settingsLoaded ||
				state.settingsPending ||
				!state.appRoot ||
				!state.appOrigin
			) {
				return;
			}
			set({ settingsPending: true, settingsError: null });
			client(state.send).updateFloatingButton(
				state.appRoot,
				state.appOrigin,
				showFloatingButton,
			);
		},

		updateCfg: (patch) => {
			const state = get();
			if (state.view === "chat" && state.conversationId) {
				const conversationId = state.conversationId;
				const conversation = state.conversations.find(
					(item) => item.id === conversationId,
				);
				const threadState = state.threads[conversationId]?.turnState ?? "idle";
				if (
					!state.connected ||
					state.configPending[conversationId] ||
					conversation?.turnState !== "idle" ||
					threadState !== "idle"
				) {
					return;
				}
				set({
					configPending: { ...state.configPending, [conversationId]: true },
				});
				client(state.send).setConfig(conversationId, patch);
			} else {
				set({ draft: { ...state.draft, ...patch } });
			}
		},

		choose: (kind, value) => {
			const state = get();
			const current = computeCfg(state);
			if (kind === "harness") {
				if (!state.harnessMap[value]?.detected) return;
				const patch: Partial<Cfg> = { harnessId: value };
				if (value !== current.harnessId) {
					patch.model = "";
					patch.effort = "";
				}
				state.updateCfg(patch);
			} else if (kind === "model") {
				const info = harnessInfo(state.harnessMap, current.harnessId);
				const model = info.models.find((candidate) => candidate.id === value);
				const patch: Partial<Cfg> = { model: value };
				if (
					model?.efforts &&
					current.effort &&
					!model.efforts.includes(current.effort)
				) {
					patch.effort = "";
				}
				state.updateCfg(patch);
			} else {
				state.updateCfg({ effort: value });
			}
		},

		toggleSelect: (node) => {
			const state = get();
			if (state.selections.some((selection) => selection.domEl === node)) {
				set({
					selections: state.selections.filter(
						(selection) => selection.domEl !== node,
					),
				});
				return;
			}
			nextSelectionId += 1;
			const selection: Selection = {
				id: nextSelectionId,
				domEl: node,
				source: resolveSource(node),
				domContext: buildDomContext(node),
			};
			set({ selections: [...state.selections, selection] });
		},
		removeSelection: (domEl) =>
			set((state) => ({
				selections: state.selections.filter(
					(selection) => selection.domEl !== domEl,
				),
			})),
		clearSelections: () => set({ selections: [] }),

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
			client(state.send).resumeConversation(conversationId);
		},
		deleteConversation: (conversationId) => {
			const state = get();
			if (!state.connected) return;
			client(state.send).deleteConversation(conversationId);
		},
		submitPrompt: (payload) => {
			const state = get();
			if (
				!state.connected ||
				state.pendingPrompt !== null ||
				selectVisibleTurnState(state) !== "idle"
			)
				return;
			if (state.view === "chat" && state.conversationId) {
				state.queueUserMessage(
					state.conversationId,
					payload.prompt,
					payload.elements.length,
				);
				client(state.send).prompt(state.conversationId, payload);
				return;
			}
			set({ pendingPrompt: payload });
			client(state.send).newConversation(state.draft);
		},
		cancelVisibleTurn: () => {
			const state = get();
			if (
				!state.connected ||
				state.view !== "chat" ||
				!state.conversationId ||
				selectVisibleTurnState(state) === "idle"
			) {
				return;
			}
			client(state.send).cancel(state.conversationId);
		},

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
					if (pending) client(state.send).prompt(conversationId, pending);
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
						configPending: withoutPending(
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
								configPending: withoutPending(
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
				case "turn_queued": {
					const conversationId = message.conversationId;
					set((current) => {
						const thread = current.threads[conversationId] ?? emptyThread();
						const next = mergeLiveTurn(thread, message.liveTurn);
						if (next === thread) return current;
						return {
							threads: { ...current.threads, [conversationId]: next },
							conversations: updateConversationTurnState(
								current.conversations,
								conversationId,
								"queued",
								message.liveTurn.queuePosition,
							),
						};
					});
					break;
				}
				case "turn_started": {
					const conversationId = message.conversationId;
					set((current) => {
						const thread = current.threads[conversationId] ?? emptyThread();
						const next = mergeLiveTurn(thread, message.liveTurn);
						if (next === thread) return current;
						return {
							threads: { ...current.threads, [conversationId]: next },
							conversations: updateConversationTurnState(
								current.conversations,
								conversationId,
								"running",
								null,
							),
						};
					});
					break;
				}
				case "harness_output": {
					const event = message.event;
					if (event.kind === "text")
						appendText(message.conversationId, message.turnId, event.text);
					else if (event.kind === "tool") {
						addBlock(message.conversationId, message.turnId, {
							t: "tool",
							name: event.name,
							detail: event.detail,
						});
					} else if (event.kind === "diff") {
						addBlock(message.conversationId, message.turnId, {
							t: "diff",
							file: event.file,
							hunks: event.hunks,
						});
					}
					break;
				}
				case "turn_complete": {
					const conversationId = message.conversationId;
					set((current) => {
						const thread = current.threads[conversationId] ?? emptyThread();
						if (thread.turnId !== message.turnId) return current;
						return {
							threads: {
								...current.threads,
								[conversationId]: finishThread(thread),
							},
							conversations: updateConversationTurnState(
								current.conversations,
								conversationId,
								"idle",
								null,
							),
						};
					});
					client(get().send).listConversations();
					break;
				}
				case "turn_error": {
					const conversationId = message.conversationId;
					set((current) => {
						const thread = current.threads[conversationId] ?? emptyThread();
						if (
							thread.turnState === "idle" ||
							message.turnId === null ||
							thread.turnId !== message.turnId
						)
							return current;
						return {
							threads: {
								...current.threads,
								[conversationId]: withSystemNote(
									finishThread(thread),
									`Error: ${message.message}`,
								),
							},
							conversations: updateConversationTurnState(
								current.conversations,
								conversationId,
								"idle",
								null,
							),
						};
					});
					client(get().send).listConversations();
					break;
				}
				case "turn_cancelled": {
					const conversationId = message.conversationId;
					set((current) => {
						const thread = current.threads[conversationId] ?? emptyThread();
						if (
							thread.turnId !== message.turnId &&
							!(thread.turnState === "queued" && thread.turnId === null)
						) {
							return current;
						}
						return {
							threads: {
								...current.threads,
								[conversationId]: finishThread(thread),
							},
							conversations: updateConversationTurnState(
								current.conversations,
								conversationId,
								"idle",
								null,
							),
						};
					});
					client(get().send).listConversations();
					break;
				}
				case "accepted":
				case "discarded": {
					const visible = state.conversationId === message.conversationId;
					if (visible)
						set({
							conversationId: null,
							view: "list",
							recordingShortcut: false,
						});
					client(get().send).listConversations();
					break;
				}
				case "reverted":
					client(get().send).listConversations();
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
							configPending: withoutPending(
								state.configPending,
								message.conversationId,
							),
						});
					}
					if (message.conversationId && message.requestType === "prompt") {
						const conversationId = message.conversationId;
						set((current) => {
							const thread = current.threads[conversationId] ?? emptyThread();
							return {
								threads: {
									...current.threads,
									[conversationId]: finishThread(thread),
								},
								conversations: updateConversationTurnState(
									current.conversations,
									conversationId,
									"idle",
									null,
								),
							};
						});
						client(get().send).listConversations();
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
						noteConversation(message.conversationId, message.message);
					} else {
						noteVisibleConversation(message.message);
					}
					break;
				}
			}
		},
	};
});

/** Turn state for the conversation currently presented in chat; hidden work never affects it. */
export function selectVisibleTurnState(state: PincerStore): TurnState {
	if (state.view !== "chat" || !state.conversationId) return "idle";
	return (
		state.threads[state.conversationId]?.turnState ??
		state.conversations.find(
			(conversation) => conversation.id === state.conversationId,
		)?.turnState ??
		"idle"
	);
}

/** Reactive command-bar config; shallow-compared so equal values don't re-render. */
export function useCfg(): Cfg {
	return usePincerStore(useShallow(computeCfg));
}
