import { expect, test } from "bun:test";
import { renderMarkdown, highlightCode } from "../src/blocks";

test("markdown renders bold and inline code", () => {
  const out = renderMarkdown("Do **this** with `code`");
  expect(out).toContain("<strong");
  expect(out).toContain(">this</strong>");
  expect(out).toContain(">code</code>");
});

test("markdown renders unordered lists and fenced code", () => {
  expect(renderMarkdown("- one\n- two")).toContain("<li>one</li>");
  const fenced = renderMarkdown("```ts\nconst a = 1 < 2;\n```");
  expect(fenced).toContain("<pre");
  expect(fenced).toContain("&lt;"); // escaped
});

test("markdown escapes raw HTML so agent output cannot inject nodes", () => {
  const out = renderMarkdown("<img src=x onerror=alert(1)>");
  expect(out).not.toContain("<img");
  expect(out).toContain("&lt;img");
});

test("highlightCode escapes and colors tokens", () => {
  const out = highlightCode('const x = "hi";');
  expect(out).toContain("const");
  expect(out).not.toContain('"hi"</span></span>'); // sanity: strings wrapped once
  expect(out).toContain("#98c379"); // string color
});
