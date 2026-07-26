import {
	MIN_HOST_VISIBLE,
	PANEL_MAX_W,
	PANEL_MIN_W,
	PANEL_W,
} from "./constants";

/** Per-origin, so a width chosen on one app doesn't follow you to the next. */
const STORAGE_KEY = "pincer:panel-width";

export function clampPanelWidth(width: number): number {
	if (!Number.isFinite(width)) return PANEL_W;
	return Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.round(width)));
}

/** Clamp again at paint time: the stored width may not fit the current viewport. */
export function fitPanelWidth(width: number, viewport: number): number {
	return Math.min(
		clampPanelWidth(width),
		Math.max(PANEL_MIN_W, viewport - MIN_HOST_VISIBLE),
	);
}

export function loadPanelWidth(): number {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		return raw === null || raw === undefined
			? PANEL_W
			: clampPanelWidth(Number(raw));
	} catch {
		return PANEL_W;
	}
}

export function savePanelWidth(width: number): void {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, String(width));
	} catch {
		// Storage can be blocked (private mode, sandboxed iframe); width just won't persist.
	}
}
