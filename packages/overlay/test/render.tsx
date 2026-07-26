import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export interface Rendered {
	container: HTMLElement;
	unmount(): void;
}

export function render(element: ReactNode): Rendered {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => {
		root.render(element);
	});
	return {
		container,
		unmount: () => {
			act(() => {
				root.unmount();
			});
			container.remove();
		},
	};
}

/** Runs `fn` inside act() so React flushes the state updates it triggers. */
export function flush(fn: () => void): void {
	act(fn);
}

export function click(node: Element | null | undefined): void {
	if (!node) throw new Error("cannot click a missing element");
	act(() => {
		(node as HTMLElement).click();
	});
}

/**
 * React installs its own value tracker on controlled inputs and swallows an
 * event whose value it believes unchanged, so the write has to go through the
 * prototype setter rather than the element property.
 */
export function typeInto(
	node: HTMLTextAreaElement | HTMLInputElement,
	value: string,
): void {
	const prototype =
		node.tagName === "TEXTAREA"
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	if (!setter) throw new Error("no value setter on the element prototype");
	act(() => {
		setter.call(node, value);
		node.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

export function press(
	node: Element | null | undefined,
	init: KeyboardEventInit,
): void {
	if (!node) throw new Error("cannot press a key on a missing element");
	act(() => {
		node.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, ...init }),
		);
	});
}

export function byLabel(container: HTMLElement, label: string): HTMLElement {
	const node = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	if (!node) throw new Error(`no element labelled "${label}"`);
	return node;
}

export function byText(container: HTMLElement, text: string): HTMLElement {
	const nodes = Array.from(container.querySelectorAll<HTMLElement>("*"));
	const match = nodes
		.reverse()
		.find((node) => node.textContent?.trim() === text);
	if (!match) throw new Error(`no element with text "${text}"`);
	return match;
}

export function buttonWithText(
	container: HTMLElement,
	text: string,
): HTMLElement {
	const match = Array.from(container.querySelectorAll("button")).find((node) =>
		node.textContent?.includes(text),
	);
	if (!match) throw new Error(`no button containing "${text}"`);
	return match;
}
