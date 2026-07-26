import { describe, expect, test } from "bun:test";
import {
	breadcrumb,
	buildDomContext,
	elementReference,
	resolveSource,
} from "../src/dom/picker";

interface FakeSpec {
	tag: string;
	id?: string;
	classes?: string[];
	text?: string;
	attrs?: Record<string, string>;
}

/**
 * The picker only reads tagName/id/classList/textContent/getAttribute and walks
 * parentElement, so a plain object covers it without a DOM implementation.
 */
function element(
	spec: FakeSpec,
	parent: HTMLElement | null = null,
): HTMLElement {
	const attrs = spec.attrs ?? {};
	return {
		tagName: spec.tag.toUpperCase(),
		id: spec.id ?? "",
		classList: spec.classes ?? [],
		textContent: spec.text ?? "",
		parentElement: parent,
		getAttribute: (name: string) => attrs[name] ?? null,
	} as unknown as HTMLElement;
}

describe("breadcrumb", () => {
	test("renders tag, id and classes", () => {
		expect(
			breadcrumb(
				element({ tag: "BUTTON", id: "save", classes: ["btn", "lg"] }),
			),
		).toBe("<button#save.btn.lg>");
	});

	test("omits an absent id and class list", () => {
		expect(breadcrumb(element({ tag: "div" }))).toBe("<div>");
	});
});

describe("buildDomContext", () => {
	test("collapses whitespace and caps the text at 80 characters", () => {
		const context = buildDomContext(
			element({ tag: "p", text: `  hello\n\t world  ${"x".repeat(100)}` }),
		);
		expect(context.text).toHaveLength(80);
		expect(context.text?.startsWith("hello world x")).toBe(true);
	});

	test("reports no text for a whitespace-only element", () => {
		expect(
			buildDomContext(element({ tag: "div", text: "   \n " })).text,
		).toBeNull();
	});

	test("collects at most five breadcrumbs, self first", () => {
		let node = element({ tag: "html" });
		for (const tag of ["body", "main", "section", "div", "span", "b"]) {
			node = element({ tag }, node);
		}
		expect(buildDomContext(node).ancestry).toEqual([
			"<b>",
			"<span>",
			"<div>",
			"<section>",
			"<main>",
		]);
	});

	test("projects tag, id and classes", () => {
		expect(
			buildDomContext(element({ tag: "LI", id: "row", classes: ["odd"] })),
		).toMatchObject({ tag: "li", id: "row", classes: ["odd"] });
	});
});

describe("resolveSource", () => {
	test("finds the attribute on the element itself", () => {
		expect(
			resolveSource(
				element({
					tag: "div",
					attrs: { "data-pincer-source": "src/App.tsx:12:4" },
				}),
			),
		).toEqual({ path: "src/App.tsx", line: 12, column: 4 });
	});

	test("walks ancestors for the nearest annotated element", () => {
		const root = element({
			tag: "section",
			attrs: { "data-pincer-source": "src/Page.tsx:3:1" },
		});
		const leaf = element({ tag: "span" }, element({ tag: "div" }, root));
		expect(resolveSource(leaf)).toEqual({
			path: "src/Page.tsx",
			line: 3,
			column: 1,
		});
	});

	test("skips a malformed attribute and keeps walking", () => {
		const root = element({
			tag: "section",
			attrs: { "data-pincer-source": "src/Page.tsx:3:1" },
		});
		const leaf = element(
			{ tag: "span", attrs: { "data-pincer-source": "garbage" } },
			root,
		);
		expect(resolveSource(leaf)).toEqual({
			path: "src/Page.tsx",
			line: 3,
			column: 1,
		});
	});

	test("returns null when nothing in the chain is annotated", () => {
		expect(
			resolveSource(element({ tag: "span" }, element({ tag: "div" }))),
		).toBeNull();
	});
});

describe("elementReference", () => {
	test("prefers the Pincer source and strips a leading slash", () => {
		expect(
			elementReference(
				element({
					tag: "div",
					attrs: { "data-pincer-source": "/src/App.tsx:12:4" },
				}),
			),
		).toBe("src/App.tsx:12:4");
	});

	test("falls back to the tsd source attribute", () => {
		expect(
			elementReference(
				element({
					tag: "div",
					attrs: { "data-tsd-source": "src/Old.tsx:1:1" },
				}),
			),
		).toBe("src/Old.tsx:1:1");
	});

	test("falls back to a DOM breadcrumb with text and ancestors", () => {
		const root = element({ tag: "main" });
		const leaf = element(
			{ tag: "button", classes: ["btn"], text: "Save" },
			root,
		);
		expect(elementReference(leaf)).toBe('[<button.btn> "Save" in <main>]');
	});

	test("omits the text and the ancestor clause when there is neither", () => {
		expect(elementReference(element({ tag: "hr" }))).toBe("[<hr>]");
	});
});
