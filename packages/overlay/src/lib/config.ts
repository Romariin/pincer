export interface PincerConfig {
  wsUrl?: string;
  contractAVersion?: number;
  projectRoot?: string;
  toggleKey?: string;
}

declare global {
  interface Window {
    __PINCER__?: PincerConfig;
    __PINCER_LOADED__?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Toggle key parsing (lenient; defaults to Alt+Shift+P — plain Alt/Alt+letter is
// swallowed by the Windows browser menu-bar accelerator before it reaches the page)
// ---------------------------------------------------------------------------
export interface ParsedToggle {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
  code: string | null;
}

export function parseToggleKey(raw: string | undefined): ParsedToggle {
  const result: ParsedToggle = { alt: false, ctrl: false, shift: false, meta: false, key: "p", code: "KeyP" };
  if (!raw) return { ...result, alt: true, shift: true };
  const parts = raw.split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return { ...result, alt: true, shift: true };
  let sawKey = false;
  for (const part of parts) {
    if (part === "alt" || part === "option") result.alt = true;
    else if (part === "ctrl" || part === "control") result.ctrl = true;
    else if (part === "shift") result.shift = true;
    else if (part === "meta" || part === "cmd" || part === "command") result.meta = true;
    else {
      result.key = part;
      sawKey = true;
    }
  }
  if (!result.alt && !result.ctrl && !result.shift && !result.meta) {
    result.alt = true;
    result.shift = true;
  }
  if (!sawKey) result.key = "p";
  result.code = /^[a-z]$/.test(result.key)
    ? `Key${result.key.toUpperCase()}`
    : /^[0-9]$/.test(result.key)
      ? `Digit${result.key}`
      : null;
  return result;
}

export function matchesToggle(toggle: ParsedToggle, e: KeyboardEvent): boolean {
  if (toggle.alt && !e.altKey) return false;
  if (toggle.ctrl && !e.ctrlKey) return false;
  if (toggle.shift && !e.shiftKey) return false;
  if (toggle.meta && !e.metaKey) return false;
  return (toggle.code !== null && e.code === toggle.code) || e.key.toLowerCase() === toggle.key;
}
