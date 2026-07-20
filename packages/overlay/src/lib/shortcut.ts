import type { KeyboardShortcut } from "@pincer/core";

export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "code" | "altKey" | "ctrlKey" | "shiftKey" | "metaKey" | "repeat"
>;

export type ShortcutCaptureResult =
  | { type: "cancel" }
  | { type: "ignore" }
  | { type: "invalid"; message: string }
  | { type: "shortcut"; shortcut: KeyboardShortcut };

const MODIFIER_CODES: Record<string, true> = {
  AltLeft: true,
  AltRight: true,
  ControlLeft: true,
  ControlRight: true,
  ShiftLeft: true,
  ShiftRight: true,
  MetaLeft: true,
  MetaRight: true,
};

export function shortcutFromEvent(event: ShortcutKeyEvent): ShortcutCaptureResult {
  if (event.code === "Escape") return { type: "cancel" };
  if (event.repeat || Object.hasOwn(MODIFIER_CODES, event.code)) return { type: "ignore" };
  if (event.code === "Unidentified") return { type: "invalid", message: "Choose another key." };
  if (!event.altKey && !event.ctrlKey && !event.metaKey) {
    return { type: "invalid", message: "Include Alt, Ctrl, or Meta plus another key." };
  }
  return {
    type: "shortcut",
    shortcut: {
      code: event.code,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    },
  };
}

export function matchesShortcut(shortcut: KeyboardShortcut, event: ShortcutKeyEvent): boolean {
  return (
    !event.repeat &&
    event.code === shortcut.code &&
    event.altKey === shortcut.alt &&
    event.ctrlKey === shortcut.ctrl &&
    event.shiftKey === shortcut.shift &&
    event.metaKey === shortcut.meta
  );
}

export function formatShortcut(shortcut: KeyboardShortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  if (shortcut.meta) parts.push("Meta");

  const keyMatch = /^Key([A-Z])$/.exec(shortcut.code);
  const digitMatch = /^Digit([0-9])$/.exec(shortcut.code);
  parts.push(keyMatch?.[1] ?? digitMatch?.[1] ?? shortcut.code);
  return parts.join("+");
}
