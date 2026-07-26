import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
	type ClientMessage,
	type KeyboardShortcut,
	type OverlaySettings,
	PROTOCOL_VERSION,
} from "@pincer/core";
import type { Emit } from "../orchestrator/types";
import { projectStorageKey } from "../paths";

export interface SettingsRepository {
	getSettings(
		appKey: string,
		appRoot: string,
		appOrigin: string,
	): OverlaySettings;
	updateSettings(
		appKey: string,
		appRoot: string,
		appOrigin: string,
		patch: { shortcut?: KeyboardShortcut; showFloatingButton?: boolean },
	): OverlaySettings;
}

type SettingsMessage = Extract<
	ClientMessage,
	{ type: "get_overlay_settings" | "update_overlay_settings" }
>;

/**
 * Settings are keyed by app root, so a page could otherwise name any path on
 * disk. Confine it under the project the daemon was started for; null means
 * the path escaped and the request must be rejected.
 */
function resolveAppRootInsideProject(
	raw: string,
	daemonProjectRoot: string,
): string | null {
	try {
		const projectRoot = realpathSync(daemonProjectRoot);
		const appRoot = realpathSync(raw);
		const relation = relative(projectRoot, appRoot);
		if (
			relation === ".." ||
			relation.startsWith(`..${sep}`) ||
			isAbsolute(relation)
		)
			return null;
		return appRoot;
	} catch {
		return null;
	}
}

function resolveHttpOrigin(raw: string): string | null {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.origin;
	} catch {
		return null;
	}
}

export function applySettingsMessage(
	raw: SettingsMessage,
	daemonProjectRoot: string,
	settings: SettingsRepository,
	emit: Emit,
): void {
	const appRoot = resolveAppRootInsideProject(raw.appRoot, daemonProjectRoot);
	if (!appRoot) {
		emit({
			v: PROTOCOL_VERSION,
			type: "error",
			code: "bad_message",
			message: "Invalid app root.",
		});
		return;
	}
	const appOrigin = resolveHttpOrigin(raw.appOrigin);
	if (!appOrigin) {
		emit({
			v: PROTOCOL_VERSION,
			type: "error",
			code: "bad_message",
			message: "Invalid app origin.",
		});
		return;
	}

	const appKey = projectStorageKey(appRoot);
	try {
		if (raw.type === "get_overlay_settings") {
			emit({
				v: PROTOCOL_VERSION,
				type: "overlay_settings",
				settings: settings.getSettings(appKey, appRoot, appOrigin),
			});
			return;
		}

		const patch: { shortcut?: KeyboardShortcut; showFloatingButton?: boolean } =
			{};
		if (raw.shortcut) patch.shortcut = raw.shortcut;
		if (typeof raw.showFloatingButton === "boolean") {
			patch.showFloatingButton = raw.showFloatingButton;
		}
		emit({
			v: PROTOCOL_VERSION,
			type: "overlay_settings",
			settings: settings.updateSettings(appKey, appRoot, appOrigin, patch),
		});
	} catch {
		emit({
			v: PROTOCOL_VERSION,
			type: "error",
			code: "settings_unavailable",
			message: "Pincer settings are unavailable.",
		});
	}
}
