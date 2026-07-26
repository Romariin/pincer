import type {
	ClientMessage,
	ConversationSummary,
	DomContext,
	HarnessDescriptor,
	KeyboardShortcut,
	PromptElement,
	ServerMessage,
	SourceLocation,
} from "@pincer/core";
import type { Cfg, ConversationThread } from "./thread";

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

export interface PincerStore {
	connected: boolean;
	view: View;
	panelOpen: boolean;
	panelWidth: number;
	resizingPanel: boolean;
	selecting: boolean;
	picker: PickerKind | null;
	referenceCopyStatus: ReferenceCopyStatus;

	shortcut: KeyboardShortcut;
	showFloatingButton: boolean;
	appRoot: string | null;
	appOrigin: string | null;
	settingsLoaded: boolean;
	settingsPending: boolean;
	settingsError: string | null;
	recordingShortcut: boolean;

	harnesses: HarnessDescriptor[];
	harnessMap: Record<string, HarnessDescriptor>;
	draft: Cfg;

	conversations: ConversationSummary[];
	conversationId: string | null;
	threads: Record<string, ConversationThread>;
	pendingPrompt: PendingPrompt | null;
	configPending: Record<string, boolean>;

	selections: Selection[];

	send: (msg: ClientMessage) => void;
	setSend: (fn: (msg: ClientMessage) => void) => void;
	setConnected: (c: boolean) => void;

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
	setAppIdentity: (
		appRoot: string | null,
		appOrigin: string | null,
		error: string | null,
	) => void;
	startRecordingShortcut: () => void;
	cancelRecordingShortcut: () => void;
	updateShortcut: (shortcut: KeyboardShortcut) => void;
	updateShowFloatingButton: (show: boolean) => void;

	updateCfg: (patch: Partial<Cfg>) => void;
	chooseCfgValue: (kind: PickerKind, value: string) => void;

	toggleSelect: (node: HTMLElement) => void;
	removeSelection: (domEl: HTMLElement) => void;
	clearSelections: () => void;

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

	applyServerMessage: (msg: ServerMessage) => void;
}

/** The store's own appRoot/appOrigin, narrowed once they are known. */
export type SettingsEditable = PincerStore & {
	appRoot: string;
	appOrigin: string;
};

/**
 * Settings requests need a live socket, a loaded snapshot, no request already
 * in flight, and an app identity to key them by.
 */
export function canEditSettings(state: PincerStore): state is SettingsEditable {
	return (
		state.connected &&
		state.settingsLoaded &&
		!state.settingsPending &&
		state.appRoot !== null &&
		state.appOrigin !== null
	);
}
