import { clampPanelWidth, savePanelWidth } from "@/lib/panelWidth";
import { canEditSettings, type PincerStore } from "./storeTypes";
import { daemon } from "./transport";

type Set = (
	partial:
		| Partial<PincerStore>
		| ((state: PincerStore) => Partial<PincerStore> | PincerStore),
) => void;
type Get = () => PincerStore;

const COPY_FEEDBACK_MS = 1600;

// Bumped on every transition so an in-flight reset timeout cannot clear a
// status that was set after it was scheduled.
let referenceCopyEpoch = 0;

export function uiActions(
	set: Set,
	get: Get,
): Pick<
	PincerStore,
	| "setPanelOpen"
	| "setPanelWidth"
	| "setResizingPanel"
	| "setView"
	| "openSettings"
	| "openPicker"
	| "closePicker"
	| "setSelecting"
	| "startCopyingReference"
	| "finishCopyingReference"
	| "setAppIdentity"
	| "startRecordingShortcut"
	| "cancelRecordingShortcut"
	| "updateShortcut"
	| "updateShowFloatingButton"
> {
	return {
		setPanelOpen: (open) => {
			if (open === get().panelOpen) return;
			if (open) {
				set({ panelOpen: true, view: "list", recordingShortcut: false });
				daemon(get().send).listConversations();
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
			referenceCopyEpoch += 1;
			set({ selecting: on, referenceCopyStatus: "idle" });
		},
		startCopyingReference: () => {
			referenceCopyEpoch += 1;
			set({ selecting: true, referenceCopyStatus: "selecting" });
		},
		finishCopyingReference: (status) => {
			set({ selecting: false, referenceCopyStatus: status });
			referenceCopyEpoch += 1;
			const epoch = referenceCopyEpoch;
			setTimeout(() => {
				if (
					referenceCopyEpoch === epoch &&
					get().referenceCopyStatus === status
				) {
					set({ referenceCopyStatus: "idle" });
				}
			}, COPY_FEEDBACK_MS);
		},
		setAppIdentity: (appRoot, appOrigin, error) =>
			set({
				appRoot,
				appOrigin,
				settingsLoaded: false,
				settingsPending: false,
				settingsError: error,
				recordingShortcut: false,
			}),
		startRecordingShortcut: () => {
			if (!canEditSettings(get())) return;
			set({ recordingShortcut: true, settingsError: null });
		},
		cancelRecordingShortcut: () => set({ recordingShortcut: false }),
		updateShortcut: (shortcut) => {
			const state = get();
			if (!canEditSettings(state)) return;
			set({
				settingsPending: true,
				settingsError: null,
				recordingShortcut: false,
			});
			daemon(state.send).updateShortcut(
				state.appRoot,
				state.appOrigin,
				shortcut,
			);
		},
		updateShowFloatingButton: (showFloatingButton) => {
			const state = get();
			if (!canEditSettings(state)) return;
			set({ settingsPending: true, settingsError: null });
			daemon(state.send).updateFloatingButton(
				state.appRoot,
				state.appOrigin,
				showFloatingButton,
			);
		},
	};
}
