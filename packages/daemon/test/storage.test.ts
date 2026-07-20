import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
import { Store } from "../src/store";
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
	expect(
		readdirSync(dirname(target)).some((name) => name.startsWith(stagingPrefix)),
	).toBe(false);
}

test("moves all legacy project data into the hashed user-data directory", () => {
	withRoots((projectRoot, dataRoot) => {
		const legacy = seedLegacy(projectRoot);
		const target = projectDataDir(projectRoot, dataRoot);
		const logs: string[] = [];

		migrateLegacyProjectData(projectRoot, dataRoot, (message) =>
			logs.push(message),
		);

		expect(existsSync(legacy)).toBe(false);
		expect(readFileSync(join(target, "history.db"), "utf8")).toBe("history");
		expect(readFileSync(join(target, "history.db-wal"), "utf8")).toBe("wal");
		expect(readFileSync(join(target, "history.db-shm"), "utf8")).toBe("shm");
		expect(readFileSync(join(target, "omp-sessions", "sentinel"), "utf8")).toBe(
			"session",
		);
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

		migrateLegacyProjectData(projectRoot, dataRoot, (message) =>
			logs.push(message),
		);

		const archives = readdirSync(target).filter((name) =>
			name.startsWith("legacy-project-data-"),
		);
		expect(existsSync(legacy)).toBe(false);
		expect(readFileSync(join(target, "active"), "utf8")).toBe("active");
		expect(archives).toHaveLength(1);
		expect(
			readFileSync(join(target, archives[0] ?? "", "history.db"), "utf8"),
		).toBe("history");
		expect(logs).toEqual([
			`archived legacy project data at ${join(target, archives[0] ?? "")}`,
		]);
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
				if (renameCalls === 1)
					throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
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

		expect(() =>
			migrateLegacyProjectData(projectRoot, dataRoot, () => {}, fs),
		).toThrow("copy failed");
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
				if (renameCalls === 1)
					throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
				throw new Error(`commit failed: ${source} -> ${destination}`);
			},
		};

		expect(() =>
			migrateLegacyProjectData(projectRoot, dataRoot, () => {}, fs),
		).toThrow("commit failed");
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
				if (renameCalls === 1)
					throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
				nodeMigrationFs.rename(source, destination);
			},
			remove(path) {
				if (path === legacy) throw new Error("source cleanup failed");
				nodeMigrationFs.remove(path);
			},
		};

		expect(() =>
			migrateLegacyProjectData(projectRoot, dataRoot, () => {}, fs),
		).toThrow("source cleanup failed");
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
		expect(
			readFileSync(join(harness.pincerDataDir, "legacy-marker"), "utf8"),
		).toBe("legacy");
		expect(existsSync(harness.historyDbPath)).toBe(true);
		expect(harness.gitOut(["status", "--porcelain"])).not.toContain(".pincer");
	} finally {
		await harness?.close();
	}
});

test("legacy Agent rows retain conversation and turn history while unsafe unqualified tokens are cleared", () => {
	const root = mkdtempSync(join(tmpdir(), "pincer-store-migration-"));
	const historyDbPath = join(root, "history.db");
	const legacy = new Database(historyDbPath);
	try {
		legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        source TEXT,
        dom_context TEXT,
        agent_session_id TEXT,
        checkpoint TEXT,
        parent_checkpoint TEXT,
        output TEXT,
        blocks TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO conversations
        (id, branch, base_branch, base_commit, status, agent_id, model, effort, created_at, updated_at)
      VALUES
        ('legacy-conversation', 'feature/legacy', 'main', 'abc123', 'active', 'omp',
         'legacy-model', 'legacy-effort', 100, 200);
      INSERT INTO turns
        (id, conversation_id, seq, prompt, source, dom_context, agent_session_id,
         checkpoint, parent_checkpoint, output, blocks, status, created_at)
      VALUES
        (17, 'legacy-conversation', 1, 'preserve this prompt', '{"path":"src/App.tsx"}',
         '{"tag":"button"}', 'unsafe-agent-token', 'checkpoint-a', 'parent-a',
         'preserve this output', '[{"t":"md","text":"preserve this output"}]', 'complete', 150);
    `);
	} finally {
		legacy.close();
	}

	const store = new Store(historyDbPath);
	store.close();
	const migrated = new Database(historyDbPath, { readonly: true });
	try {
		expect(migrated.query("SELECT * FROM conversations").get()).toEqual({
			id: "legacy-conversation",
			branch: "feature/legacy",
			base_branch: "main",
			base_commit: "abc123",
			status: "active",
			harness_id: "omp",
			model: "legacy-model",
			effort: "legacy-effort",
			created_at: 100,
			updated_at: 200,
		});
		expect(migrated.query("SELECT * FROM turns").get()).toEqual({
			id: 17,
			conversation_id: "legacy-conversation",
			seq: 1,
			prompt: "preserve this prompt",
			source: '{"path":"src/App.tsx"}',
			dom_context: '{"tag":"button"}',
			harness_id: "omp",
			resume_token: null,
			checkpoint: "checkpoint-a",
			parent_checkpoint: "parent-a",
			output: "preserve this output",
			blocks: '[{"t":"md","text":"preserve this output"}]',
			status: "complete",
			created_at: 150,
		});
		expect(
			(
				migrated.query("PRAGMA table_info(turns)").all() as { name: string }[]
			).map((column) => column.name),
		).not.toContain("agent_session_id");
		expect(
			migrated
				.query("SELECT value FROM meta WHERE key = 'schema_version'")
				.get(),
		).toEqual({
			value: "2",
		});
	} finally {
		migrated.close();
		rmSync(root, { recursive: true, force: true });
	}
});
