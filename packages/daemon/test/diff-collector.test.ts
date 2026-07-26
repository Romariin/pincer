import { expect, test } from "bun:test";
import { collectNewDiffEvents, parseUnifiedDiff } from "../src/diffCollector";

const before = `diff --git a/src/App.tsx b/src/App.tsx
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1 +1 @@
-old
+shared`;
const after = `${before}
@@ -3 +3 @@
-shared
+new`;

test("diff collection is pure and removes only matching pre-existing hunks", () => {
	const snapshot = new Map(
		parseUnifiedDiff(before).map((event) => [event.file, event.hunks]),
	);
	expect(collectNewDiffEvents(snapshot, after)).toEqual([
		{
			kind: "diff",
			file: "src/App.tsx",
			hunks: [
				{ type: "del", text: "shared" },
				{ type: "add", text: "new" },
			],
		},
	]);
	expect(snapshot.get("src/App.tsx")).toEqual([
		{ type: "del", text: "old" },
		{ type: "add", text: "shared" },
	]);
});
