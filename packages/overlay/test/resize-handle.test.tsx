import { afterEach, describe, expect, test } from "bun:test";
import { ResizeHandle } from "../src/components/ResizeHandle";
import { PANEL_MAX_W, PANEL_MIN_W, PANEL_W } from "../src/lib/constants";
import { usePincerStore } from "../src/state/store";
import { resetStore } from "./fixtures";
import { flush, press, type Rendered, render } from "./render";

const store = () => usePincerStore.getState();

let view: Rendered | null = null;

afterEach(() => {
	view?.unmount();
	view = null;
});

function mount(width = PANEL_W): HTMLElement {
	resetStore();
	usePincerStore.setState({ panelWidth: width });
	view = render(<ResizeHandle />);
	const handle =
		view.container.querySelector<HTMLElement>('[role="separator"]');
	if (!handle) throw new Error("no resize handle rendered");
	return handle;
}

/** The panel is docked right, so dragging left by `distance` widens it. */
function drag(handle: HTMLElement, distance: number): void {
	flush(() => {
		handle.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				clientX: 1000,
				pointerId: 1,
			}),
		);
	});
	flush(() => {
		window.dispatchEvent(
			new PointerEvent("pointermove", { clientX: 1000 - distance }),
		);
	});
	flush(() => {
		window.dispatchEvent(new PointerEvent("pointerup", {}));
	});
}

describe("keyboard resizing", () => {
	test("ArrowLeft widens and ArrowRight narrows by one step", () => {
		const handle = mount(500);
		press(handle, { key: "ArrowLeft" });
		expect(store().panelWidth).toBe(516);
		press(handle, { key: "ArrowRight" });
		expect(store().panelWidth).toBe(500);
	});

	test("Shift takes the coarse step", () => {
		const handle = mount(500);
		press(handle, { key: "ArrowLeft", shiftKey: true });
		expect(store().panelWidth).toBe(564);
	});

	test("Home and End jump to the bounds", () => {
		const handle = mount(500);
		press(handle, { key: "Home" });
		expect(store().panelWidth).toBe(PANEL_MAX_W);
		press(handle, { key: "End" });
		expect(store().panelWidth).toBe(PANEL_MIN_W);
	});

	test("an unrelated key changes nothing", () => {
		const handle = mount(500);
		press(handle, { key: "a" });
		expect(store().panelWidth).toBe(500);
	});

	test("the announced value tracks the width", () => {
		const handle = mount(500);
		expect(handle.getAttribute("aria-valuenow")).toBe("500");
		press(handle, { key: "ArrowLeft" });
		expect(handle.getAttribute("aria-valuenow")).toBe("516");
		expect(handle.getAttribute("aria-valuemin")).toBe(String(PANEL_MIN_W));
		expect(handle.getAttribute("aria-valuemax")).toBe(String(PANEL_MAX_W));
	});
});

describe("pointer resizing", () => {
	test("dragging away from the edge widens the panel", () => {
		const handle = mount(500);
		drag(handle, 80);
		expect(store().panelWidth).toBe(580);
	});

	test("the resizing flag is raised for the drag and lowered after it", () => {
		const handle = mount(500);

		flush(() => {
			handle.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					button: 0,
					clientX: 1000,
					pointerId: 1,
				}),
			);
		});
		expect(store().resizingPanel).toBe(true);
		expect(handle.getAttribute("data-resizing")).toBe("true");

		flush(() => {
			window.dispatchEvent(new PointerEvent("pointerup", {}));
		});
		expect(store().resizingPanel).toBe(false);
	});

	test("a non-primary button starts no drag", () => {
		const handle = mount(500);
		flush(() => {
			handle.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					button: 2,
					clientX: 1000,
					pointerId: 1,
				}),
			);
		});
		expect(store().resizingPanel).toBe(false);
	});

	test("moves after the release are ignored", () => {
		const handle = mount(500);
		drag(handle, 80);
		flush(() => {
			window.dispatchEvent(new PointerEvent("pointermove", { clientX: 200 }));
		});
		expect(store().panelWidth).toBe(580);
	});

	test("double-clicking restores the default width", () => {
		const handle = mount(700);
		flush(() => {
			handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(store().panelWidth).toBe(PANEL_W);
	});
});
