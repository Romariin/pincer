export interface SourceLocation {
  path: string;
  line: number;
  column: number;
}

/**
 * Parse a `data-pincer-source` value of the form `<relpath>:<line>:<column>`.
 * Splits on the last two colons so POSIX paths (which never contain colons)
 * round-trip cleanly. Returns null on any malformed input.
 */
export function parseSourceAttr(value: string): SourceLocation | null {
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const prevColon = value.lastIndexOf(":", lastColon - 1);
  if (prevColon <= 0) return null;

  const path = value.slice(0, prevColon);
  const line = Number(value.slice(prevColon + 1, lastColon));
  const column = Number(value.slice(lastColon + 1));

  if (path.length === 0) return null;
  if (!Number.isInteger(line) || !Number.isInteger(column)) return null;
  return { path, line, column };
}

export function formatSourceAttr(loc: SourceLocation): string {
  return `${loc.path}:${loc.line}:${loc.column}`;
}
