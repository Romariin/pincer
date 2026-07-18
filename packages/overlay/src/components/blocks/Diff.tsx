import { PatchDiff } from "@pierre/diffs/react";
import type { ReactNode } from "react";
import type { DiffHunk } from "@pincer/core";

/** Reconstruct a unified-diff string from the daemon's structured hunks; the filename drives Shiki's language. */
function toPatch(file: string, hunks: DiffHunk[]): string {
  let oldC = 0;
  let newC = 0;
  let body = "";
  for (const h of hunks) {
    if (h.type === "ctx") {
      oldC++;
      newC++;
      body += ` ${h.text}\n`;
    } else if (h.type === "del") {
      oldC++;
      body += `-${h.text}\n`;
    } else {
      newC++;
      body += `+${h.text}\n`;
    }
  }
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${oldC} +1,${newC} @@\n${body}`;
}

export function Diff({ file, hunks }: { file: string; hunks: DiffHunk[] }): ReactNode {
  const patch = toPatch(file, hunks);
  return (
    <div className="overflow-hidden rounded-[10px] border border-border text-xs">
      <PatchDiff patch={patch} options={{ theme: "github-dark-default", diffStyle: "unified" }} disableWorkerPool />
    </div>
  );
}
