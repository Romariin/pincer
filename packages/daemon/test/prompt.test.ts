import { expect, test } from "bun:test";
import { composePrompt } from "../src/harnesses/prompt";
import type { HarnessTurnRequest } from "../src/harnesses/types";

const base: HarnessTurnRequest = {
	prompt: "make it red",
	projectRoot: "/tmp",
	pincerDataDir: "/tmp/.pincer-data",
	conversationId: "c1",
	resumeToken: null,
	selection: { harnessId: "omp", model: "", effort: "" },
	source: null,
	domContext: {
		tag: "unknown",
		id: null,
		classes: [],
		text: null,
		ancestry: [],
	},
};

test("single-element prompt identifies the selected source and DOM element", () => {
	const request: HarnessTurnRequest = {
		...base,
		source: { path: "src/App.tsx", line: 4, column: 6 },
		domContext: {
			tag: "h1",
			id: null,
			classes: [],
			text: "Title",
			ancestry: ["h1", "main"],
		},
	};
	const output = composePrompt(request);
	expect(output).toContain("clicked an element");
	expect(output).toContain("Selected element:");
	expect(output).toContain("src/App.tsx (line 4, column 6)");
	expect(output).toContain("<h1> Title");
	expect(output).toContain("make it red");
});

test("multi-selection preserves every source mapping and unmapped DOM target", () => {
	const request: HarnessTurnRequest = {
		...base,
		source: { path: "src/App.tsx", line: 4, column: 6 },
		domContext: {
			tag: "h1",
			id: null,
			classes: [],
			text: "Title",
			ancestry: ["h1"],
		},
		elements: [
			{
				source: { path: "src/App.tsx", line: 4, column: 6 },
				domContext: {
					tag: "h1",
					id: null,
					classes: [],
					text: "Title",
					ancestry: ["h1"],
				},
			},
			{
				source: null,
				domContext: {
					tag: "button",
					id: null,
					classes: ["btn"],
					text: "Submit",
					ancestry: ["button"],
				},
			},
		],
	};
	const output = composePrompt(request);
	expect(output).toContain("clicked 2 elements");
	expect(output).toContain("Selected elements:");
	expect(output).toContain("1. Source: src/App.tsx (line 4, column 6)");
	expect(output).toContain("2. Source mapping was unavailable");
	expect(output).toContain("<button.btn> Submit");
});
