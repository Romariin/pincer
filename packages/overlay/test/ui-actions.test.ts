import { afterEach, describe, expect, jest, test } from "bun:test";
import { PANEL_MAX_W, PANEL_MIN_W } from "../src/lib/constants";
import { usePincerStore } from "../src/state/store";
import type { PincerStore } from "../src/state/storeTypes";
import { canEditSettings } from "../src/state/storeTypes";
import { pendingPrompt, recordSentFrames, resetStore } from "./fixtures";

const store = () => usePincerStore.getState();

function element(tag: string): HTMLElement {
	return {
		tagName: tag.toUpperCase(),
		id: "",
		classList: [],
		textContent: "",
		parentElement: null,
		getAttribute: () => null,
	} as unknown as HTMLElement;
}

afterEach(() => {
	jest.useRealTimers();
});

describe("panel visibility", () => {
	test("opening the panel resets to the list and asks for a fresh listing", () => {
		resetStore();
		const sent = recordSentFrames();
		usePincerStore.setState({ view: "settings", recordingShortcut: true });

		store().setPanelOpen(true);

		expect(store()).toMatchObject({
			panelOpen: true,
			view: "list",
			recordingShortcut: false,
		});
		expect(sent.map((frame) => frame.type)).toEqual(["list_conversations"]);
	});

	test("reopening an already open panel sends nothing", () => {
		resetStore();
		store().setPanelOpen(true);
		const sent = recordSentFrames();

		store().setPanelOpen(true);

		expect(sent).toEqual([]);
	});

	test("closing the panel drops every transient interaction", () => {
		resetStore();
		store().setPanelOpen(true);
		usePincerStore.setState({
			selecting: true,
			referenceCopyStatus: "copied",
			picker: "model",
			recordingShortcut: true,
		});

		store().setPanelOpen(false);

		expect(store()).toMatchObject({
			panelOpen: false,
			selecting: false,
			referenceCopyStatus: "idle",
			picker: null,
			recordingShortcut: false,
		});
	});
});

describe("panel width", () => {
	test("clamps a drag beyond the allowed range", () => {
		resetStore();
		store().setPanelWidth(5000);
		expect(store().panelWidth).toBe(PANEL_MAX_W);
		store().setPanelWidth(10);
		expect(store().panelWidth).toBe(PANEL_MIN_W);
	});

	test("persists the clamped width so it survives a reload", () => {
		resetStore();
		const written: Record<string, string> = {};
		const previous = globalThis.localStorage;
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => written[key] ?? null,
				setItem: (key: string, value: string) => {
					written[key] = value;
				},
			},
		});
		try {
			store().setPanelWidth(512);
			expect(written["pincer:panel-width"]).toBe("512");
		} finally {
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: previous,
			});
		}
	});
});

describe("view switching", () => {
	test("leaving the settings view stops a shortcut recording", () => {
		resetStore();
		usePincerStore.setState({ view: "settings", recordingShortcut: true });
		store().setView("list");
		expect(store().recordingShortcut).toBe(false);
	});

	test("staying inside the settings view keeps the recording alive", () => {
		resetStore();
		usePincerStore.setState({ view: "settings", recordingShortcut: true });
		store().setView("settings");
		expect(store().recordingShortcut).toBe(true);
	});

	test("opening settings atomically clears picker, selecting and copy status", () => {
		resetStore();
		usePincerStore.setState({
			picker: "harness",
			selecting: true,
			referenceCopyStatus: "copied",
			recordingShortcut: true,
		});

		store().openSettings();

		expect(store()).toMatchObject({
			view: "settings",
			picker: null,
			selecting: false,
			referenceCopyStatus: "idle",
			recordingShortcut: false,
		});
	});
});

describe("reference copy feedback", () => {
	test("clears itself once the feedback delay elapses", () => {
		jest.useFakeTimers();
		resetStore();

		store().startCopyingReference();
		expect(store()).toMatchObject({
			selecting: true,
			referenceCopyStatus: "selecting",
		});

		store().finishCopyingReference("copied");
		expect(store()).toMatchObject({
			selecting: false,
			referenceCopyStatus: "copied",
		});

		jest.advanceTimersByTime(1600);
		expect(store().referenceCopyStatus).toBe("idle");
	});

	test("an in-flight reset cannot clear a status set after it was scheduled", () => {
		jest.useFakeTimers();
		resetStore();

		store().finishCopyingReference("copied");
		jest.advanceTimersByTime(800);
		store().startCopyingReference();
		jest.advanceTimersByTime(800);

		expect(store().referenceCopyStatus).toBe("selecting");
	});

	// Same status twice: only the epoch tells the two timeouts apart, so this is
	// what a status-only guard would get wrong.
	test("a second copy of the same status gets its own full delay", () => {
		jest.useFakeTimers();
		resetStore();

		store().finishCopyingReference("copied");
		jest.advanceTimersByTime(1000);
		store().finishCopyingReference("copied");

		jest.advanceTimersByTime(600);
		expect(store().referenceCopyStatus).toBe("copied");
		jest.advanceTimersByTime(900);
		expect(store().referenceCopyStatus).toBe("copied");

		jest.advanceTimersByTime(100);
		expect(store().referenceCopyStatus).toBe("idle");
	});

	test("a failed copy clears on its own timeout", () => {
		jest.useFakeTimers();
		resetStore();

		store().finishCopyingReference("error");
		jest.advanceTimersByTime(1600);
		expect(store().referenceCopyStatus).toBe("idle");
	});
});

describe("element selections", () => {
	test("toggling the same node adds it then removes it", () => {
		resetStore();
		const node = element("button");

		store().toggleSelect(node);
		expect(
			store().selections.map((selection) => selection.domEl === node),
		).toEqual([true]);

		store().toggleSelect(node);
		expect(store().selections).toHaveLength(0);
	});

	test("each selection captures its source and DOM context", () => {
		resetStore();
		store().toggleSelect(element("li"));
		expect(store().selections[0]).toMatchObject({
			source: null,
			domContext: { tag: "li", id: null, classes: [], text: null },
		});
	});

	test("removeSelection drops one node and clearSelections drops them all", () => {
		resetStore();
		const first = element("a");
		const second = element("b");
		store().toggleSelect(first);
		store().toggleSelect(second);

		store().removeSelection(first);
		expect(
			store().selections.map((selection) => selection.domEl === second),
		).toEqual([true]);

		store().clearSelections();
		expect(store().selections).toHaveLength(0);
	});
});

describe("settings guard", () => {
	const editable = {
		connected: true,
		settingsLoaded: true,
		settingsPending: false,
		appRoot: "/project",
		appOrigin: "http://localhost:5173",
	};

	test("accepts a connected, loaded, idle store with a known app identity", () => {
		resetStore();
		usePincerStore.setState(editable);
		expect(canEditSettings(store())).toBe(true);
	});

	const rejected: Array<[string, Partial<PincerStore>]> = [
		["disconnected", { connected: false }],
		["not yet loaded", { settingsLoaded: false }],
		["a request already in flight", { settingsPending: true }],
		["no app root", { appRoot: null }],
		["no app origin", { appOrigin: null }],
	];

	test.each(rejected)("rejects %s", (_label, patch) => {
		resetStore();
		usePincerStore.setState({ ...editable, ...patch });
		expect(canEditSettings(store())).toBe(false);

		const sent = recordSentFrames();
		store().updateShowFloatingButton(false);
		store().startRecordingShortcut();
		expect(sent).toEqual([]);
		expect(store().recordingShortcut).toBe(false);
	});
});

test("disconnecting releases every acknowledgement the daemon owed", () => {
	resetStore();
	usePincerStore.setState({
		connected: true,
		settingsLoaded: true,
		settingsPending: true,
		recordingShortcut: true,
		configPending: { c1: true },
		pendingPrompt: pendingPrompt("p"),
	});

	store().setConnected(false);

	expect(store()).toMatchObject({
		connected: false,
		settingsLoaded: false,
		settingsPending: false,
		recordingShortcut: false,
		configPending: {},
		pendingPrompt: null,
	});
});
