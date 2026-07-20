import { expect, test } from "bun:test";
import type { AgentTask } from "@pincer/core";
import { composePrompt } from "../src/agents/prompt";

const base = { prompt: "make it red", projectRoot: "/tmp", pincerDataDir: "/tmp/.pincer-data", conversationId: "c1", resumeSessionId: null, model: null, effort: null };

test("single-element prompt names the source and element", () => {
  const task: AgentTask = {
    ...base,
    source: { path: "src/App.tsx", line: 4, column: 6 },
    domContext: { tag: "h1", id: null, classes: [], text: "Title", ancestry: ["h1", "main"] },
  };
  const out = composePrompt(task);
  expect(out).toContain("clicked an element");
  expect(out).toContain("Selected element:");
  expect(out).toContain("src/App.tsx (line 4, column 6)");
  expect(out).toContain("<h1> Title");
  expect(out).toContain("make it red");
});

test("multiple elements are each numbered and rendered", () => {
  const task: AgentTask = {
    ...base,
    source: { path: "src/App.tsx", line: 4, column: 6 },
    domContext: { tag: "h1", id: null, classes: [], text: "Title", ancestry: ["h1"] },
    elements: [
      { source: { path: "src/App.tsx", line: 4, column: 6 }, domContext: { tag: "h1", id: null, classes: [], text: "Title", ancestry: ["h1"] } },
      { source: null, domContext: { tag: "button", id: null, classes: ["btn"], text: "Submit", ancestry: ["button"] } },
    ],
  };
  const out = composePrompt(task);
  expect(out).toContain("clicked 2 elements");
  expect(out).toContain("Selected elements:");
  expect(out).toContain("1. Source: src/App.tsx (line 4, column 6)");
  expect(out).toContain("2. Source mapping was unavailable");
  expect(out).toContain("<button.btn> Submit");
});
