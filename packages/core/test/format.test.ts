/// <reference types="bun-types" />
import { test, expect } from "bun:test";
import { parseSourceAttr, formatSourceAttr } from "../src/source";

test("round-trips a source location", () => {
  const loc = { path: "src/App.tsx", line: 12, column: 4 };
  const s = formatSourceAttr(loc);
  expect(s).toBe("src/App.tsx:12:4");
  expect(parseSourceAttr(s)).toEqual(loc);
});

test("parses paths that themselves contain colons", () => {
  // Only the last two colons are the line/column separators.
  expect(parseSourceAttr("weird:name.tsx:3:0")).toEqual({
    path: "weird:name.tsx",
    line: 3,
    column: 0,
  });
});

test("returns null for malformed attrs", () => {
  expect(parseSourceAttr("")).toBeNull();
  expect(parseSourceAttr("nocolons")).toBeNull();
  expect(parseSourceAttr("only:one")).toBeNull();
  expect(parseSourceAttr("path:notanumber:4")).toBeNull();
  expect(parseSourceAttr(":5:0")).toBeNull();
});
