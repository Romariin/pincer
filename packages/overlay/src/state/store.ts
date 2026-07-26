import { DEFAULT_TOGGLE_SHORTCUT } from "@pincer/core";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { loadPanelWidth } from "@/lib/panelWidth";
import { configActions } from "./configActions";
import { conversationActions } from "./conversationActions";
import { selectionActions } from "./selectionActions";
import { activeCfg } from "./selectors";
import { serverMessageActions } from "./serverMessages";
import type { PincerStore } from "./storeTypes";
import type { Cfg } from "./thread";
import { uiActions } from "./uiActions";

export const usePincerStore = create<PincerStore>()((set, get) => ({
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

	...uiActions(set, get),
	...configActions(set, get),
	...selectionActions(set, get),
	...conversationActions(set, get),
	...serverMessageActions(set, get),
}));

/** Reactive command-bar config; shallow-compared so equal values don't re-render. */
export function useActiveCfg(): Cfg {
	return usePincerStore(useShallow(activeCfg));
}
