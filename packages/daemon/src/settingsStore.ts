import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	DEFAULT_TOGGLE_SHORTCUT,
	type KeyboardShortcut,
	type OverlaySettings,
} from "@pincer/core";

interface GlobalSettingsRow {
	shortcut_code: string;
	alt: number;
	ctrl: number;
	shift: number;
	meta: number;
}

interface SiteSettingsRow {
	show_floating_button: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS global_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  shortcut_code TEXT NOT NULL,
  alt INTEGER NOT NULL CHECK (alt IN (0,1)),
  ctrl INTEGER NOT NULL CHECK (ctrl IN (0,1)),
  shift INTEGER NOT NULL CHECK (shift IN (0,1)),
  meta INTEGER NOT NULL CHECK (meta IN (0,1))
);
CREATE TABLE IF NOT EXISTS site_settings (
  app_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  show_floating_button INTEGER NOT NULL CHECK (show_floating_button IN (0,1)),
  PRIMARY KEY (app_key, origin)
);
`;

export interface OverlaySettingsPatch {
	shortcut?: KeyboardShortcut;
	showFloatingButton?: boolean;
}

export class SettingsStore {
	private readonly db: Database;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path);
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.db
			.query(
				`INSERT OR IGNORE INTO global_settings
          (id, shortcut_code, alt, ctrl, shift, meta)
         VALUES (1, $code, $alt, $ctrl, $shift, $meta)`,
			)
			.run({
				$code: DEFAULT_TOGGLE_SHORTCUT.code,
				$alt: Number(DEFAULT_TOGGLE_SHORTCUT.alt),
				$ctrl: Number(DEFAULT_TOGGLE_SHORTCUT.ctrl),
				$shift: Number(DEFAULT_TOGGLE_SHORTCUT.shift),
				$meta: Number(DEFAULT_TOGGLE_SHORTCUT.meta),
			});
	}

	getSettings(
		appKey: string,
		appRoot: string,
		appOrigin: string,
	): OverlaySettings {
		const global = this.db
			.query<GlobalSettingsRow, []>(
				"SELECT shortcut_code, alt, ctrl, shift, meta FROM global_settings WHERE id = 1",
			)
			.get();
		if (!global) throw new Error("Missing global settings row.");
		const site = this.db
			.query<SiteSettingsRow, { $appKey: string; $origin: string }>(
				`SELECT show_floating_button
         FROM site_settings
         WHERE app_key = $appKey AND origin = $origin`,
			)
			.get({ $appKey: appKey, $origin: appOrigin });

		return {
			appRoot,
			appOrigin,
			shortcut: {
				code: global.shortcut_code,
				alt: global.alt === 1,
				ctrl: global.ctrl === 1,
				shift: global.shift === 1,
				meta: global.meta === 1,
			},
			showFloatingButton: site ? site.show_floating_button === 1 : true,
		};
	}

	updateSettings(
		appKey: string,
		appRoot: string,
		appOrigin: string,
		patch: OverlaySettingsPatch,
	): OverlaySettings {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (patch.shortcut) {
				this.db
					.query(
						`UPDATE global_settings
             SET shortcut_code = $code, alt = $alt, ctrl = $ctrl, shift = $shift, meta = $meta
             WHERE id = 1`,
					)
					.run({
						$code: patch.shortcut.code,
						$alt: Number(patch.shortcut.alt),
						$ctrl: Number(patch.shortcut.ctrl),
						$shift: Number(patch.shortcut.shift),
						$meta: Number(patch.shortcut.meta),
					});
			}
			if (patch.showFloatingButton !== undefined) {
				this.db
					.query(
						`INSERT INTO site_settings (app_key, origin, show_floating_button)
             VALUES ($appKey, $origin, $show)
             ON CONFLICT (app_key, origin)
             DO UPDATE SET show_floating_button = excluded.show_floating_button`,
					)
					.run({
						$appKey: appKey,
						$origin: appOrigin,
						$show: Number(patch.showFloatingButton),
					});
			}
			const snapshot = this.getSettings(appKey, appRoot, appOrigin);
			this.db.exec("COMMIT");
			return snapshot;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}
}
