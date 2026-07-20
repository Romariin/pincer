import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { DEFAULT_TOGGLE_SHORTCUT, PROTOCOL_VERSION } from "@pincer/core";
import type {
	ClientMessage,
	ConversationSummary,
	DomContext,
	HarnessDescriptor,
	KeyboardShortcut,
	LiveTurnSnapshot,
	MessageBlock,
	PromptElement,
	ServerMessage,
	SourceLocation,
	TurnState,
} from "@pincer/core";
import { harnessInfo } from "@/lib/harness";
import { buildDomContext, resolveSource } from "@/dom/picker";

export type View = "list" | "chat" | "settings";
export type PickerKind = "harness" | "model" | "effort";

export interface Cfg {
	harnessId: string;
	model: string;
	effort: string;
}

export interface Msg {
	id: number;
	role: "user" | "assistant" | "system";
	blocks: MessageBlock[];
	/** Command-bar config captured when an assistant turn began (drives the meta badge). */
	meta?: Cfg;
	/** Number of elements attached to a user prompt (drives the chip count label). */
	elementCount?: number;
}

export interface ConversationThread {
	messages: Msg[];
	/** Index of the assistant message receiving output for the live turn. */
	streamingIndex: number | null;
	turnState: TurnState;
	queuePosition: number | null;
	turnId: number | null;
	liveTurnSeq: number | null;
}

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

let nextMessageId = 0;
let nextSelectionId = 0;

function createMessageId(): number {
	nextMessageId += 1;
	return nextMessageId;
}

export interface PincerStore {
	// ---- connection / view ----
	connected: boolean;
	view: View;
	panelOpen: boolean;
	selecting: boolean;
	picker: PickerKind | null;

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

	// ---- element selections ----
	selections: Selection[];

	// ---- socket ----
	send: (msg: ClientMessage) => void;
	setSend: (fn: (msg: ClientMessage) => void) => void;
	setConnected: (c: boolean) => void;

	// ---- UI ops ----
	setPanelOpen: (open: boolean) => void;
	setView: (view: View) => void;
	openPicker: (kind: PickerKind) => void;
	openSettings: () => void;
	closePicker: () => void;
	setSelecting: (on: boolean) => void;
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

function userMsg(text: string, count: number): Msg {
	return {
		id: createMessageId(),
		role: "user",
		blocks: [{ t: "md", text }],
		elementCount: count,
	};
}

function emptyThread(): ConversationThread {
	return {
		messages: [],
		streamingIndex: null,
		turnState: "idle",
		queuePosition: null,
		turnId: null,
		liveTurnSeq: null,
	};
}

function conversationCfg(conversation: ConversationSummary): Cfg {
	return {
		harnessId: conversation.harnessId,
		model: conversation.model,
		effort: conversation.effort,
	};
}

function upsertConversation(
	conversations: ConversationSummary[],
	conversation: ConversationSummary,
): ConversationSummary[] {
	return [
		conversation,
		...conversations.filter((item) => item.id !== conversation.id),
	];
}

function replaceConversation(
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

function updateConversationTurnState(
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

function mergeLiveTurn(
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

	if (!sameLiveTurn) {
		messages = [...messages, userMsg(liveTurn.prompt, 0)];
	}

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
			messages = [
				...messages,
				{
					id: createMessageId(),
					role: "assistant",
					blocks: liveTurn.blocks,
					meta,
				},
			];
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

function finishThread(thread: ConversationThread): ConversationThread {
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

function withSystemNote(
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
				messages = [
					...messages,
					{ id: createMessageId(), role: "assistant", blocks: [], meta },
				];
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
				messages = [
					...messages,
					{ id: createMessageId(), role: "assistant", blocks: [], meta },
				];
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

	const noteVisibleConversation = (text: string): void => {
		const state = get();
		if (state.view !== "chat" || !state.conversationId) return;
		const conversationId = state.conversationId;
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

	return {
		connected: false,
		view: "list",
		panelOpen: false,
		selecting: false,
		picker: null,

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
						},
			),

		setPanelOpen: (open) => {
			if (open === get().panelOpen) return;
			if (open) {
				set({ panelOpen: true, view: "list", recordingShortcut: false });
				get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
			} else {
				set({
					panelOpen: false,
					selecting: false,
					picker: null,
					recordingShortcut: false,
				});
			}
		},
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
				recordingShortcut: false,
			}),
		openPicker: (kind) => set({ picker: kind }),
		closePicker: () => set({ picker: null }),
		setSelecting: (on) => set({ selecting: on }),
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
			state.send({
				v: PROTOCOL_VERSION,
				type: "update_overlay_settings",
				appRoot: state.appRoot,
				appOrigin: state.appOrigin,
				shortcut,
			});
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
			state.send({
				v: PROTOCOL_VERSION,
				type: "update_overlay_settings",
				appRoot: state.appRoot,
				appOrigin: state.appOrigin,
				showFloatingButton,
			});
		},

		updateCfg: (patch) => {
			const state = get();
			if (state.view === "chat" && state.conversationId) {
				const conversationId = state.conversationId;
				set({
					conversations: state.conversations.map((conversation) =>
						conversation.id === conversationId
							? { ...conversation, ...patch }
							: conversation,
					),
				});
				state.send({
					v: PROTOCOL_VERSION,
					type: "set_config",
					conversationId,
					...patch,
				});
			} else {
				set({ draft: { ...state.draft, ...patch } });
			}
		},

		choose: (kind, value) => {
			const state = get();
			const current = computeCfg(state);
			if (kind === "harness") {
				const info = harnessInfo(state.harnessMap, value);
				const patch: Partial<Cfg> = { harnessId: value };
				if (value !== current.harnessId) {
					patch.model = info.defaultModel;
					patch.effort = info.defaultEffort;
				}
				state.updateCfg(patch);
			} else if (kind === "model") {
				state.updateCfg({ model: value });
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
					const harnessId = retained ? state.draft.harnessId : defaultHarnessId;
					const info = harnessInfo(harnessMap, harnessId);
					const model = retained ? state.draft.model : info.defaultModel;
					const effort = retained ? state.draft.effort : info.defaultEffort;
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
					if (pending) {
						state.send({
							v: PROTOCOL_VERSION,
							type: "prompt",
							conversationId,
							...pending,
						});
					}
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
						if (turn.blocks.length) {
							messages.push({
								id: createMessageId(),
								role: "assistant",
								blocks: turn.blocks,
								meta: cfg,
							});
						}
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
							};
						});
					} else {
						set({ pendingPrompt: null });
					}
					break;
				}
				case "turn_queued": {
					const conversationId = message.conversationId;
					set((current) => ({
						threads: {
							...current.threads,
							[conversationId]: mergeLiveTurn(
								current.threads[conversationId] ?? emptyThread(),
								message.liveTurn,
							),
						},
						conversations: updateConversationTurnState(
							current.conversations,
							conversationId,
							"queued",
							message.liveTurn.queuePosition,
						),
					}));
					break;
				}
				case "turn_started": {
					const conversationId = message.conversationId;
					set((current) => ({
						threads: {
							...current.threads,
							[conversationId]: mergeLiveTurn(
								current.threads[conversationId] ?? emptyThread(),
								message.liveTurn,
							),
						},
						conversations: updateConversationTurnState(
							current.conversations,
							conversationId,
							"running",
							null,
						),
					}));
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
					get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
					break;
				}
				case "turn_error": {
					const conversationId = message.conversationId;
					set((current) => {
						const thread = current.threads[conversationId] ?? emptyThread();
						if (thread.turnId !== message.turnId) return current;
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
					get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
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
					get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
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
					get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
					break;
				}
				case "reverted":
					get().send({ v: PROTOCOL_VERSION, type: "list_conversations" });
					break;
				case "error": {
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
