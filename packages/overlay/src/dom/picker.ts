import { SOURCE_ATTR, parseSourceAttr } from "@pincer/core";
import type { DomContext, SourceLocation } from "@pincer/core";

/** Walk ancestors for the nearest `data-pincer-source` attribute (Contract A). */
export function resolveSource(node: HTMLElement): SourceLocation | null {
  let cur: HTMLElement | null = node;
  while (cur) {
    const attr = cur.getAttribute(SOURCE_ATTR);
    if (attr) {
      const parsed = parseSourceAttr(attr);
      if (parsed) return parsed;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** `tag#id.class` breadcrumb for a single element. */
export function breadcrumb(node: HTMLElement): string {
  let s = `<${node.tagName.toLowerCase()}`;
  if (node.id) s += `#${node.id}`;
  const cls = Array.from(node.classList);
  if (cls.length) s += `.${cls.join(".")}`;
  return `${s}>`;
}

export function buildDomContext(node: HTMLElement): DomContext {
  const rawText = (node.textContent ?? "").trim().replace(/\s+/g, " ");
  const text = rawText.length > 0 ? rawText.slice(0, 80) : null;
  const ancestry: string[] = [];
  let cur: HTMLElement | null = node;
  while (cur && ancestry.length < 5) {
    ancestry.push(breadcrumb(cur));
    cur = cur.parentElement;
  }
  return { tag: node.tagName.toLowerCase(), id: node.id || null, classes: Array.from(node.classList), text, ancestry };
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Viewport-relative rect for an element (fixed positioning is viewport-relative even in a shadow root). */
export function place(node: HTMLElement): Rect {
  const r = node.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}
