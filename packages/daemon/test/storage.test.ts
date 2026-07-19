import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  migrateLegacyProjectData,
  nodeMigrationFs,
  projectDataDir,
  type MigrationFs,
} from "../src/paths";
import { createHarness, type Harness } from "./harness";

function withRoots(run: (projectRoot: string, dataRoot: string) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), "pincer-storage-project-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "pincer-storage-data-"));
  try {
    run(projectRoot, dataRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

function seedLegacy(projectRoot: string): string {
  const legacy = join(projectRoot, ".pincer");
  mkdirSync(join(legacy, "omp-sessions"), { recursive: true });
  writeFileSync(join(legacy, "history.db"), "history");
  writeFileSync(join(legacy, "history.db-wal"), "wal");
  writeFileSync(join(legacy, "history.db-shm"), "shm");
  writeFileSync(join(legacy, "omp-sessions", "sentinel"), "session");
  return legacy;
}

function expectNoStaging(target: string): void {
  const stagingPrefix = `${basename(target)}.migrating-`;
  expect(readdirSync(dirname(target)).some((name) => name.startsWith(stagingPrefix))).toBe(false);
}

test("moves all legacy project data into the hashed user-data directory", () => {
  withRoots((projectRoot, dataRoot) => {
    const legacy = seedLegacy(projectRoot);
    const target = projectDataDir(projectRoot, dataRoot);
    const logs: string[] = [];

    migrateLegacyProjectData(projectRoot, dataRoot, (message) => logs.push(message));

    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(target, "history.db"), "utf8")).toBe("history");
    expect(readFileSync(join(target, "history.db-wal"), "utf8")).toBe("wal");
    expect(readFileSync(join(target, "history.db-shm"), "utf8")).toBe("shm");
    expect(readFileSync(join(target, "omp-sessions", "sentinel"), "utf8")).toBe("session");
    expect(logs).toEqual([`migrated project data to ${target}`]);
  });
});

test("archives legacy data when the hashed target already exists", () => {
  withRoots((projectRoot, dataRoot) => {
    const legacy = seedLegacy(projectRoot);
    const target = projectDataDir(projectRoot, dataRoot);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "active"), "active");
    const logs: string[] = [];

    migrateLegacyProjectData(projectRoot, dataRoot, (message) => logs.push(message));

    const archives = readdirSync(target).filter((name) => name.startsWith("legacy-project-data-"));
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(target, "active"), "utf8")).toBe("active");
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(target, archives[0] ?? "", "history.db"), "utf8")).toBe("history");
    expect(logs).toEqual([`archived legacy project data at ${join(target, archives[0] ?? "")}`]);
  });
});

test("falls back to copy, commit, and source removal on EXDEV", () => {
  withRoots((projectRoot, dataRoot) => {
    const legacy = seedLegacy(projectRoot);
    const target = projectDataDir(projectRoot, dataRoot);
    let renameCalls = 0;
    const fs: MigrationFs = {
      ...nodeMigrationFs,
      rename(source, destination) {
        renameCalls += 1;
        if (renameCalls === 1) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        nodeMigrationFs.rename(source, destination);
      },
    };

    migrateLegacyProjectData(projectRoot, dataRoot, () => {}, fs);

    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(target, "history.db"), "utf8")).toBe("history");
    expectNoStaging(target);
  });
});

test("copy failure removes staging and preserves the complete source", () => {
  withRoots((projectRoot, dataRoot) => {
    const legacy = seedLegacy(projectRoot);
    const target = projectDataDir(projectRoot, dataRoot);
    const fs: MigrationFs = {
      ...nodeMigrationFs,
      rename() {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      },
      copy() {
        throw new Error("copy failed");
      },
    };

    expect(() => migrateLegacyProjectData(projectRoot, dataRoot, () => {}, fs)).toThrow("copy failed");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(legacy, "history.db"), "utf8")).toBe("history");
    expectNoStaging(target);
  });
});

test("staging commit failure removes staging and preserves the complete source", () => {
  withRoots((projectRoot, dataRoot) => {
    const legacy = seedLegacy(projectRoot);
    const target = projectDataDir(projectRoot, dataRoot);
    let renameCalls = 0;
    const fs: MigrationFs = {
      ...nodeMigrationFs,
      rename(source, destination) {
        renameCalls += 1;
        if (renameCalls === 1) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        throw new Error(`commit failed: ${source} -> ${destination}`);
      },
    };

    expect(() => migrateLegacyProjectData(projectRoot, dataRoot, () => {}, fs)).toThrow("commit failed");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(legacy, "history.db"), "utf8")).toBe("history");
    expectNoStaging(target);
  });
});

test("source cleanup failure preserves the committed destination", () => {
  withRoots((projectRoot, dataRoot) => {
    const legacy = seedLegacy(projectRoot);
    const target = projectDataDir(projectRoot, dataRoot);
    let renameCalls = 0;
    const fs: MigrationFs = {
      ...nodeMigrationFs,
      rename(source, destination) {
        renameCalls += 1;
        if (renameCalls === 1) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        nodeMigrationFs.rename(source, destination);
      },
      remove(path) {
        if (path === legacy) throw new Error("source cleanup failed");
        nodeMigrationFs.remove(path);
      },
    };

    expect(() => migrateLegacyProjectData(projectRoot, dataRoot, () => {}, fs)).toThrow(
      "source cleanup failed",
    );
    expect(readFileSync(join(target, "history.db"), "utf8")).toBe("history");
    expect(readFileSync(join(legacy, "history.db"), "utf8")).toBe("history");
    expectNoStaging(target);
  });
});

test("daemon startup migrates legacy data without recreating project runtime files", async () => {
  let harness: Harness | undefined;
  try {
    harness = await createHarness({ seedLegacyData: true });
    expect(existsSync(join(harness.dir, ".pincer"))).toBe(false);
    expect(readFileSync(join(harness.pincerDataDir, "legacy-marker"), "utf8")).toBe("legacy");
    expect(existsSync(harness.historyDbPath)).toBe(true);
    expect(harness.gitOut(["status", "--porcelain"])).not.toContain(".pincer");
  } finally {
    await harness?.close();
  }
});
