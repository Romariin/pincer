/// <reference types="bun-types" />
import { test, expect } from "bun:test";
import * as babel from "@babel/core";
import { pincerBabel } from "../src/babelPlugin";

function transform(code: string, filename: string, root: string): string {
  const out = babel.transformSync(code, {
    filename,
    root,
    plugins: [pincerBabel({ root })],
    parserOpts: { plugins: ["jsx", "typescript"] },
    babelrc: false,
    configFile: false,
  });
  return out?.code ?? "";
}

/** 1-based line + 0-based column of the given needle's first char in `code`. */
function posOf(code: string, needle: string): { line: number; column: number } {
  const idx = code.indexOf(needle);
  if (idx < 0) throw new Error(`needle not found: ${needle}`);
  const before = code.slice(0, idx);
  const lines = before.split("\n");
  const line = lines.length;
  const column = (lines[lines.length - 1] ?? "").length;
  return { line, column };
}

const ROOT = "/abs/root";
const FILE = "/abs/root/src/App.tsx";

const SOURCE = [
  "export default function App() {",
  "  return (",
  "    <>",
  "      <Widget prop={1} />",
  '      <div className="x">',
  "        <span>hi</span>",
  "      </div>",
  "    </>",
  "  );",
  "}",
  "",
].join("\n");

test("tags host elements only, skipping components and fragments", () => {
  const out = transform(SOURCE, FILE, ROOT);
  const count = (out.match(/data-pincer-source/g) ?? []).length;
  // host <div> + host <span> = 2; <Widget> and <> get none.
  expect(count).toBe(2);
  // <App> (the function name, no JSX) and <Widget> carry nothing.
  expect(out).not.toMatch(/Widget[^>]*data-pincer-source/);
});

test("emits POSIX-relative path with correct line/column", () => {
  const out = transform(SOURCE, FILE, ROOT);

  const divPos = posOf(SOURCE, "<div");
  const spanPos = posOf(SOURCE, "<span");

  const divExpected = `data-pincer-source="src/App.tsx:${divPos.line}:${divPos.column}"`;
  const spanExpected = `data-pincer-source="src/App.tsx:${spanPos.line}:${spanPos.column}"`;

  expect(out).toContain(divExpected);
  expect(out).toContain(spanExpected);
});

test("idempotent: re-transforming tagged output adds no second attribute", () => {
  const first = transform(SOURCE, FILE, ROOT);
  const firstCount = (first.match(/data-pincer-source/g) ?? []).length;
  const second = transform(first, FILE, ROOT);
  const secondCount = (second.match(/data-pincer-source/g) ?? []).length;
  expect(secondCount).toBe(firstCount);
});
