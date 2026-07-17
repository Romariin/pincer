const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Syntax-highlight a code string into safe HTML spans (escaped first). */
export function highlightCode(code: string): string {
  const re =
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\b\d+\b|\b(?:function|const|let|var|return|if|else|for|import|from|export|default|class|new|await|async|true|false|null)\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let out = "";
  while ((m = re.exec(code))) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    const t = m[0];
    let col = "#c9c9d0";
    if (/^["'`]/.test(t)) col = "#98c379";
    else if (t.startsWith("//")) col = "#6b6a72";
    else if (/^\d/.test(t)) col = "#d19a66";
    else col = "#f7a8c4";
    out += `<span style="color:${col}">${escapeHtml(t)}</span>`;
    last = re.lastIndex;
  }
  if (last < code.length) out += escapeHtml(code.slice(last));
  return out;
}

function inline(t: string): string {
  // Escape, protect inline code, then bold — mirrors the design's inline().
  let r = escapeHtml(t);
  const codes: string[] = [];
  r = r.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(
      `<code style="font-family:${MONO};font-size:0.9em;background:color-mix(in oklch,var(--primary) 15%,transparent);color:var(--primary);padding:1px 5px;border-radius:5px;">${c}</code>`,
    );
    return `\u0001${codes.length - 1}\u0001`;
  });
  r = r.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700;color:var(--foreground);">$1</strong>');
  r = r.replace(/\u0001(\d+)\u0001/g, (_m, n: string) => codes[Number(n)] ?? "");
  return r;
}

/** Markdown → HTML: fenced code, lists, bold, inline code, paragraphs. */
export function renderMarkdown(src: string): string {
  const blocks: string[] = [];
  const withoutFences = src.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_m, _lang: string, body: string) => {
    blocks.push(
      `<pre style="margin:.5em 0;padding:11px;background:var(--card);border:1px solid var(--border);border-radius:10px;overflow-x:auto;font-family:${MONO};font-size:12px;line-height:1.55;color:var(--foreground);"><code>${highlightCode(body.replace(/\n$/, ""))}</code></pre>`,
    );
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  const lines = withoutFences.split("\n");
  const out: string[] = [];
  let list: string[] | null = null;
  const flush = (): void => {
    if (list) {
      out.push(
        `<ul style="margin:3px 0;padding-left:18px;display:flex;flex-direction:column;gap:4px;">${list.join("")}</ul>`,
      );
      list = null;
    }
  };
  for (const ln of lines) {
    const fence = ln.match(/^\u0000B(\d+)\u0000$/);
    if (fence) {
      flush();
      out.push(blocks[Number(fence[1])] ?? "");
      continue;
    }
    if (/^\s*[-*]\s+/.test(ln)) {
      if (!list) list = [];
      list.push(`<li>${inline(ln.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (ln.trim() === "") {
      flush();
    } else {
      flush();
      out.push(`<div style="margin:2px 0;">${inline(ln)}</div>`);
    }
  }
  flush();
  return out.join("");
}
