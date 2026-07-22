import type { DiffHunk, HarnessEvent } from "@pincer/core";

const MAX_DIFF_FILES = 8;
const MAX_DIFF_LINES = 240;

type DiffEvent = Extract<HarnessEvent, { kind: "diff" }>;

export function parseUnifiedDiff(raw: string): DiffEvent[] {
	if (!raw.trim()) return [];
	const files: DiffEvent[] = [];
	let current: DiffEvent | null = null;
	let inHunk = false;
	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git")) {
			current = { kind: "diff", file: "", hunks: [] };
			files.push(current);
			inHunk = false;
			continue;
		}
		if (!current) continue;
		if (line.startsWith("+++ b/")) {
			current.file = line.slice(6);
			continue;
		}
		if (line.startsWith("+++ ")) {
			current.file = line.slice(4).replace(/^b\//, "");
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk || current.hunks.length >= MAX_DIFF_LINES) continue;
		if (line.startsWith("+") && !line.startsWith("+++")) {
			current.hunks.push({ type: "add", text: line.slice(1) });
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			current.hunks.push({ type: "del", text: line.slice(1) });
		} else if (line.startsWith(" ")) {
			current.hunks.push({ type: "ctx", text: line.slice(1) });
		}
	}
	return files.filter((file) => file.file.length > 0 && file.hunks.length > 0);
}

export function collectNewDiffEvents(
	before: ReadonlyMap<string, readonly DiffHunk[]>,
	rawAfter: string,
): DiffEvent[] {
	return parseUnifiedDiff(rawAfter)
		.map((block) => {
			const priorCounts = new Map<string, number>();
			for (const hunk of before.get(block.file) ?? []) {
				const key = `${hunk.type}\u0000${hunk.text}`;
				priorCounts.set(key, (priorCounts.get(key) ?? 0) + 1);
			}
			const hunks = block.hunks.filter((hunk) => {
				const key = `${hunk.type}\u0000${hunk.text}`;
				const count = priorCounts.get(key) ?? 0;
				if (count === 0) return true;
				priorCounts.set(key, count - 1);
				return false;
			});
			return { ...block, hunks };
		})
		.filter((block) => block.hunks.length > 0)
		.slice(0, MAX_DIFF_FILES);
}

export interface DiffSource {
	rawDiff(paths?: string[], signal?: AbortSignal): Promise<string>;
}

export class GitDiffCollector {
	constructor(private readonly source: DiffSource) {}

	async snapshot(signal?: AbortSignal): Promise<Map<string, DiffHunk[]>> {
		try {
			return new Map(
				parseUnifiedDiff(await this.source.rawDiff([], signal)).map((event) => [
					event.file,
					event.hunks,
				]),
			);
		} catch {
			return new Map();
		}
	}

	async collect(
		before: ReadonlyMap<string, readonly DiffHunk[]>,
		signal?: AbortSignal,
	): Promise<DiffEvent[]> {
		try {
			return collectNewDiffEvents(
				before,
				await this.source.rawDiff([], signal),
			);
		} catch {
			return [];
		}
	}
}
