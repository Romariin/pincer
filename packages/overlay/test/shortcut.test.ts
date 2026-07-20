import { expect, test } from "bun:test";
import {
  formatShortcut,
  matchesShortcut,
  shortcutFromEvent,
  type ShortcutKeyEvent,
} from "../src/lib/shortcut";

const baseEvent: ShortcutKeyEvent = {
  code: "KeyK",
  altKey: false,
  ctrlKey: true,
  shiftKey: true,
  metaKey: false,
  repeat: false,
};

test("shortcut capture cancels on Escape", () => {
  expect(shortcutFromEvent({ ...baseEvent, code: "Escape" })).toEqual({ type: "cancel" });
});

test("shortcut capture ignores repeats and bare modifiers", () => {
  expect(shortcutFromEvent({ ...baseEvent, repeat: true })).toEqual({ type: "ignore" });
  for (const code of [
    "AltLeft",
    "AltRight",
    "ControlLeft",
    "ControlRight",
    "ShiftLeft",
    "ShiftRight",
    "MetaLeft",
    "MetaRight",
  ]) {
    expect(shortcutFromEvent({ ...baseEvent, code })).toEqual({ type: "ignore" });
  }
});

test("shortcut capture rejects unidentified and primary-modifier-free keys", () => {
  expect(shortcutFromEvent({ ...baseEvent, code: "Unidentified" })).toEqual({
    type: "invalid",
    message: "Choose another key.",
  });
  expect(
    shortcutFromEvent({
      ...baseEvent,
      code: "KeyA",
      ctrlKey: false,
      shiftKey: true,
    }),
  ).toEqual({
    type: "invalid",
    message: "Include Alt, Ctrl, or Meta plus another key.",
  });
});

test("shortcut capture returns physical code and every modifier", () => {
  expect(shortcutFromEvent(baseEvent)).toEqual({
    type: "shortcut",
    shortcut: { code: "KeyK", alt: false, ctrl: true, shift: true, meta: false },
  });
});

test("shortcut matching requires exact physical code and modifier state", () => {
  const shortcut = { code: "KeyK", alt: false, ctrl: true, shift: true, meta: false };
  expect(matchesShortcut(shortcut, baseEvent)).toBe(true);
  expect(matchesShortcut(shortcut, { ...baseEvent, code: "KeyJ" })).toBe(false);
  expect(matchesShortcut(shortcut, { ...baseEvent, altKey: true })).toBe(false);
  expect(matchesShortcut(shortcut, { ...baseEvent, repeat: true })).toBe(false);
});

test("shortcut formatting uses stable modifier order and readable key codes", () => {
  expect(formatShortcut({ code: "KeyK", alt: true, ctrl: true, shift: true, meta: true })).toBe(
    "Ctrl+Alt+Shift+Meta+K",
  );
  expect(formatShortcut({ code: "Digit1", alt: true, ctrl: false, shift: false, meta: false })).toBe(
    "Alt+1",
  );
  expect(formatShortcut({ code: "ArrowUp", alt: false, ctrl: true, shift: false, meta: false })).toBe(
    "Ctrl+ArrowUp",
  );
});
