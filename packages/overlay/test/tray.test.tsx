import { afterEach, describe, expect, test } from "bun:test";
import { Tray } from "../src/components/Tray";
import { usePincerStore } from "../src/state/store";
import { resetStore } from "./fixtures";
import { byLabel, click, flush, type Rendered, render } from "./render";

const store = () => usePincerStore.getState();

let view: Rendered | null = null;

afterEach(() => {
	view?.unmount();
	view = null;
	document.body.replaceChildren();
});

function element(tag: string, className?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	document.body.append(node);
	return node;
}

function mount(): HTMLElement {
	view = render(<Tray />);
	return view.container;
}

function chips(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll("span"))
		.filter((node) => node.querySelector('[aria-label="Remove element"]'))
		.map((node) => node.firstChild?.textContent ?? "");
}

describe("selection chips", () => {
	test("no strip is rendered until something is selected", () => {
		resetStore();
		const container = mount();
		expect(chips(container)).toEqual([]);
	});

	test("each selection shows its breadcrumb", () => {
		resetStore();
		store().toggleSelect(element("button", "btn primary"));
		store().toggleSelect(element("li"));
		const container = mount();

		expect(chips(container)).toEqual(["<button.btn.primary>", "<li>"]);
	});

	test("the chip's remove button drops only that selection", () => {
		resetStore();
		const first = element("button");
		store().toggleSelect(first);
		store().toggleSelect(element("li"));
		const container = mount();

		const remove = container.querySelectorAll('[aria-label="Remove element"]');
		click(remove[0]);

		expect(chips(container)).toEqual(["<li>"]);
		expect(
			store().selections.some((selection) => selection.domEl === first),
		).toBe(false);
	});

	test("the strip disappears once the last selection is removed", () => {
		resetStore();
		store().toggleSelect(element("li"));
		const container = mount();

		click(container.querySelector('[aria-label="Remove element"]'));

		expect(chips(container)).toEqual([]);
	});
});

describe("add element", () => {
	test("toggles selection mode on and back off", () => {
		resetStore();
		const container = mount();
		const add = Array.from(container.querySelectorAll("button")).find((node) =>
			node.textContent?.includes("Add element"),
		);

		click(add);
		expect(store().selecting).toBe(true);

		click(add);
		expect(store().selecting).toBe(false);
	});
});

describe("copy reference", () => {
	test("starting a copy enters selection mode and announces the step", () => {
		resetStore();
		const container = mount();

		click(byLabel(container, "Copy element reference"));

		expect(store()).toMatchObject({
			selecting: true,
			referenceCopyStatus: "selecting",
		});
		expect(container.textContent).toContain("Select element");
	});

	test("clicking again while picking cancels the copy", () => {
		resetStore();
		const container = mount();
		click(byLabel(container, "Copy element reference"));

		click(byLabel(container, "Cancel copying element reference"));

		expect(store()).toMatchObject({
			selecting: false,
			referenceCopyStatus: "idle",
		});
	});

	test("a successful copy is announced", () => {
		resetStore();
		const container = mount();
		flush(() => store().finishCopyingReference("copied"));
		expect(container.textContent).toContain("Copied");
	});

	test("a failed copy invites a retry", () => {
		resetStore();
		const container = mount();
		flush(() => store().finishCopyingReference("error"));
		expect(container.textContent).toContain("Try again");
	});
});
