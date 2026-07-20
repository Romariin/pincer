import { SOURCE_ATTR, formatSourceAttr, parseSourceAttr } from "@pincer/core";
import type { DomContext, SourceLocation } from "@pincer/core";
const TSD_SOURCE_ATTR = "data-tsd-source";

function resolveAttributeSource(node: HTMLElement, attribute: string): SourceLocation | null {
  let cur: HTMLElement | null = node;
  while (cur) {
    const attr = cur.getAttribute(attribute);
    if (attr) {
      const parsed = parseSourceAttr(attr);
      if (parsed) return parsed;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** Walk ancestors for the nearest `data-pincer-source` attribute (Contract A). */
export function resolveSource(node: HTMLElement): SourceLocation | null {
  return resolveAttributeSource(node, SOURCE_ATTR);
}
export function elementReference(node: HTMLElement): string {
  const source = resolveSource(node) ?? resolveAttributeSource(node, TSD_SOURCE_ATTR);
  if (source) return formatSourceAttr({ ...source, path: source.path.replace(/^\/+/, "") });

  const context = buildDomContext(node);
  const element = context.ancestry[0] ?? `<${context.tag}>`;
  const text = context.text ? ` ${JSON.stringify(context.text)}` : "";
  const parents = context.ancestry.slice(1).join(" > ");
  return `[${element}${text}${parents ? ` in ${parents}` : ""}]`;
}

export async function copyElementReference(node: HTMLElement): Promise<void> {
  const reference = elementReference(node);
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(reference);
      return;
    } catch {
      // Clipboard permissions can reject even after a user gesture; use the legacy fallback below.
    }
  }

  const field = document.createElement("textarea");
  field.value = reference;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Clipboard write failed");
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
