import { afterEach, describe, expect, test } from "bun:test";
import type { ClientMessage } from "@pincer/core";
import { DEFAULT_TOGGLE_SHORTCUT, PROTOCOL_VERSION } from "@pincer/core";
import { SettingsView } from "../src/components/SettingsView";
import { usePincerStore } from "../src/state/store";
import { recordSentFrames, resetStore } from "./fixtures";
import {
	buttonWithText,
	click,
	flush,
	press,
	type Rendered,
	render,
} from "./render";

const store = () => usePincerStore.getState();

let view: Rendered | null = null;

afterEach(() => {
	view?.unmount();
	view = null;
});

const EDITABLE = {
	connected: true,
	settingsLoaded: true,
	settingsPending: false,
	settingsError: null,
	appRoot: "/project",
	appOrigin: "http://localhost:5173",
} as const;

function mount(): { container: HTMLElement; sent: ClientMessage[] } {
	const sent = recordSentFrames();
	view = render(<SettingsView />);
	return { container: view.container, sent };
}

function editable(): { container: HTMLElement; sent: ClientMessage[] } {
	resetStore();
	usePincerStore.setState(EDITABLE);
	return mount();
}

const checkbox = (container: HTMLElement): HTMLInputElement => {
	const node = container.querySelector<HTMLInputElement>(
		'input[type="checkbox"]',
	);
	if (!node) throw new Error("no toggle rendered");
	return node;
};

describe("recording a shortcut", () => {
	test("the recorder announces that it is capturing", () => {
		const { container } = editable();

		click(buttonWithText(container, "Change"));

		expect(store().recordingShortcut).toBe(true);
		expect(
			buttonWithText(container, "Press keys…").getAttribute("aria-pressed"),
		).toBe("true");
	});

	test("a valid combination is sent to the daemon", () => {
		const { container, sent } = editable();
		click(buttonWithText(container, "Change"));

		press(buttonWithText(container, "Press keys…"), {
			key: "K",
			code: "KeyK",
			metaKey: true,
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			type: "update_overlay_settings",
			appRoot: "/project",
			appOrigin: "http://localhost:5173",
		});
		expect(store()).toMatchObject({
			settingsPending: true,
			recordingShortcut: false,
		});
	});

	test("Escape cancels without sending anything", () => {
		const { container, sent } = editable();
		click(buttonWithText(container, "Change"));

		press(buttonWithText(container, "Press keys…"), {
			key: "Escape",
			code: "Escape",
		});

		expect(store().recordingShortcut).toBe(false);
		expect(sent).toEqual([]);
	});

	test("holding a modifier alone keeps waiting, silently", () => {
		const { container, sent } = editable();
		click(buttonWithText(container, "Change"));

		press(buttonWithText(container, "Press keys…"), {
			key: "Meta",
			code: "MetaLeft",
			metaKey: true,
		});

		expect(sent).toEqual([]);
		expect(store().recordingShortcut).toBe(true);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	test("a key with no modifier is refused with a visible reason", () => {
		const { container, sent } = editable();
		click(buttonWithText(container, "Change"));

		press(buttonWithText(container, "Press keys…"), {
			key: "K",
			code: "KeyK",
		});

		expect(sent).toEqual([]);
		expect(store().recordingShortcut).toBe(true);
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"Include Alt, Ctrl, or Meta plus another key.",
		);
	});

	test("Reset asks for the default shortcut", () => {
		const { container, sent } = editable();

		click(buttonWithText(container, "Reset"));

		expect(sent[0]).toMatchObject({
			type: "update_overlay_settings",
			shortcut: DEFAULT_TOGGLE_SHORTCUT,
		});
	});
});

describe("floating button", () => {
	test("toggling it sends the new value", () => {
		const { container, sent } = editable();

		click(checkbox(container));

		expect(sent[0]).toMatchObject({
			type: "update_overlay_settings",
			showFloatingButton: false,
		});
		expect(store().settingsPending).toBe(true);
	});

	test("the box mirrors the acknowledged value, not the click", () => {
		const { container } = editable();
		click(checkbox(container));
		expect(checkbox(container).checked).toBe(true);

		flush(() =>
			store().applyServerMessage({
				v: PROTOCOL_VERSION,
				type: "overlay_settings",
				settings: {
					appRoot: "/project",
					appOrigin: "http://localhost:5173",
					shortcut: DEFAULT_TOGGLE_SHORTCUT,
					showFloatingButton: false,
				},
			}),
		);

		expect(checkbox(container).checked).toBe(false);
	});
});

describe("controls availability", () => {
	test("everything is disabled while disconnected", () => {
		resetStore();
		const { container } = mount();

		expect(buttonWithText(container, "Change").hasAttribute("disabled")).toBe(
			true,
		);
		expect(checkbox(container).disabled).toBe(true);
		expect(container.textContent).toContain("Connect to the Pincer daemon");
	});

	test("a connected but unloaded view says it is still loading", () => {
		resetStore();
		usePincerStore.setState({ connected: true });
		const { container } = mount();

		expect(container.textContent).toContain("Loading settings…");
		expect(buttonWithText(container, "Change").hasAttribute("disabled")).toBe(
			true,
		);
	});

	test("a request in flight disables the controls and says it is saving", () => {
		resetStore();
		usePincerStore.setState({ ...EDITABLE, settingsPending: true });
		const { container } = mount();

		expect(container.textContent).toContain("Saving…");
		expect(checkbox(container).disabled).toBe(true);
	});

	test("a daemon failure is surfaced and stops hiding behind the loading line", () => {
		resetStore();
		usePincerStore.setState({
			connected: true,
			settingsError: "Settings are unavailable.",
		});
		const { container } = mount();

		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"Settings are unavailable.",
		);
		expect(container.textContent).not.toContain("Loading settings…");
	});
});

describe("app identity", () => {
	test("the known app and site are shown", () => {
		const { container } = editable();
		expect(container.textContent).toContain("/project");
		expect(container.textContent).toContain("http://localhost:5173");
	});

	test("an unknown identity reads as unavailable", () => {
		resetStore();
		usePincerStore.setState({ connected: true, settingsError: "no identity" });
		const { container } = mount();
		expect(container.textContent).toContain("Unavailable");
	});
});
