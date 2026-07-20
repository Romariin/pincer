import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ServerMessage } from "@pincer/core";
import { handleSettingsMessage, type SettingsRepository } from "../src/server";

const unavailable: ServerMessage = {
  v: PROTOCOL_VERSION,
  type: "error",
  code: "settings_unavailable",
  message: "Pincer settings are unavailable.",
};

const throwingRepository: SettingsRepository = {
  getSettings() {
    throw new Error("database unavailable");
  },
  updateSettings() {
    throw new Error("database unavailable");
  },
};

test("settings reads report storage failures without relabeling them", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pincer-settings-dispatch-"));
  try {
    const emitted: ServerMessage[] = [];
    const handled = handleSettingsMessage(
      {
        v: PROTOCOL_VERSION,
        type: "get_overlay_settings",
        appRoot: projectRoot,
        appOrigin: "http://localhost:5173",
      },
      projectRoot,
      throwingRepository,
      (message) => emitted.push(message),
    );

    expect(handled).toBe(true);
    expect(emitted).toEqual([unavailable]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("settings updates report storage failures without relabeling them", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pincer-settings-dispatch-"));
  try {
    const emitted: ServerMessage[] = [];
    const handled = handleSettingsMessage(
      {
        v: PROTOCOL_VERSION,
        type: "update_overlay_settings",
        appRoot: projectRoot,
        appOrigin: "http://localhost:5173",
        showFloatingButton: false,
      },
      projectRoot,
      throwingRepository,
      (message) => emitted.push(message),
    );

    expect(handled).toBe(true);
    expect(emitted).toEqual([unavailable]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
