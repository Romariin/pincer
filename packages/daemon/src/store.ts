import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConversationSummary } from "@pincer/core";

export interface ConversationRow {
	id: string;
	branch: string;
	base_branch: string;
	base_commit: string;
	status: string;
	harness_id: string;
	model: string;
	effort: string;
	created_at: number;
	updated_at: number;
}

export interface TurnRow {
	id: number;
	conversation_id: string;
	seq: number;
	prompt: string;
	source: string | null;
	dom_context: string | null;
	harness_id: string;
	resume_token: string | null;
	checkpoint: string | null;
	parent_checkpoint: string | null;
	output: string | null;
	blocks: string | null;
	status: string;
	created_at: number;
}

export type NewTurnRow = Omit<TurnRow, "id">;
export type TurnPatch = Partial<
	Pick<
		TurnRow,
		| "harness_id"
		| "resume_token"
		| "checkpoint"
		| "parent_checkpoint"
		| "output"
		| "blocks"
		| "status"
	>
>;

interface TableColumn {
	name: string;
}

const CONVERSATIONS_TABLE = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL,
  harness_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const TURNS_TABLE = `
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  source TEXT,
  dom_context TEXT,
  harness_id TEXT NOT NULL,
  resume_token TEXT,
  checkpoint TEXT,
  parent_checkpoint TEXT,
  output TEXT,
  blocks TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (resume_token IS NULL OR harness_id <> '')
)`;

const SCHEMA = `
${CONVERSATIONS_TABLE.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")};
${TURNS_TABLE.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")};
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Persistent conversation/turn history at an explicit user-data database path. */
export class Store {
	private readonly db: Database;

	constructor(historyDbPath: string) {
		mkdirSync(dirname(historyDbPath), { recursive: true });
		this.db = new Database(historyDbPath);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.migrateLegacySchema();
		this.db
			.query("UPDATE turns SET status = 'error' WHERE status = 'running'")
			.run();
	}

	private tableColumns(table: "conversations" | "turns"): Set<string> {
		const rows = this.db
			.query(`PRAGMA table_info(${table})`)
			.all() as TableColumn[];
		return new Set(rows.map((row) => row.name));
	}

	/**
	 * Schema v2 removes the legacy Agent ownership columns. A legacy session
	 * token cannot be resumed safely because it did not identify its issuing
	 * Harness, so those tokens intentionally migrate to NULL.
	 */
	private migrateLegacySchema(): void {
		const conversationColumns = this.tableColumns("conversations");
		const turnColumns = this.tableColumns("turns");
		const legacyConversationHarnessColumn = "agent_id";
		const legacyTurnTokenColumn = "agent_session_id";
		const conversationNeedsMigration =
			conversationColumns.has(legacyConversationHarnessColumn) ||
			["harness_id", "model", "effort"].some(
				(column) => !conversationColumns.has(column),
			);
		const turnNeedsMigration =
			turnColumns.has(legacyTurnTokenColumn) ||
			["harness_id", "resume_token", "blocks"].some(
				(column) => !turnColumns.has(column),
			);

		if (!conversationNeedsMigration && !turnNeedsMigration) {
			this.db
				.query(
					`INSERT INTO meta (key, value) VALUES ($key, $value)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				)
				.run({ $key: "schema_version", $value: "2" });
			return;
		}

		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (conversationNeedsMigration) {
				const harness = conversationColumns.has("harness_id")
					? conversationColumns.has(legacyConversationHarnessColumn)
						? `COALESCE(NULLIF(harness_id, ''), "${legacyConversationHarnessColumn}", '')`
						: "COALESCE(harness_id, '')"
					: conversationColumns.has(legacyConversationHarnessColumn)
						? `COALESCE("${legacyConversationHarnessColumn}", '')`
						: "''";
				const model = conversationColumns.has("model")
					? "COALESCE(model, '')"
					: "''";
				const effort = conversationColumns.has("effort")
					? "COALESCE(effort, '')"
					: "''";

				this.db.exec(
					"ALTER TABLE conversations RENAME TO conversations_legacy_v1",
				);
				this.db.exec(CONVERSATIONS_TABLE);
				this.db.exec(
					`INSERT INTO conversations
             (id, branch, base_branch, base_commit, status, harness_id, model, effort, created_at, updated_at)
           SELECT id, branch, base_branch, base_commit, status, ${harness}, ${model}, ${effort},
                  created_at, updated_at
           FROM conversations_legacy_v1`,
				);
				this.db.exec("DROP TABLE conversations_legacy_v1");
			}

			if (turnNeedsMigration) {
				const turnHarness = turnColumns.has("harness_id")
					? `COALESCE(NULLIF(legacy.harness_id, ''), conversation.harness_id, '')`
					: "COALESCE(conversation.harness_id, '')";
				const resumeToken =
					turnColumns.has("resume_token") && turnColumns.has("harness_id")
						? "CASE WHEN legacy.harness_id <> '' THEN legacy.resume_token ELSE NULL END"
						: "NULL";
				const blocks = turnColumns.has("blocks") ? "legacy.blocks" : "NULL";

				this.db.exec("ALTER TABLE turns RENAME TO turns_legacy_v1");
				this.db.exec(TURNS_TABLE);
				this.db.exec(
					`INSERT INTO turns
             (id, conversation_id, seq, prompt, source, dom_context, harness_id, resume_token,
              checkpoint, parent_checkpoint, output, blocks, status, created_at)
           SELECT legacy.id, legacy.conversation_id, legacy.seq, legacy.prompt, legacy.source,
                  legacy.dom_context, ${turnHarness}, ${resumeToken}, legacy.checkpoint,
                  legacy.parent_checkpoint, legacy.output, ${blocks}, legacy.status, legacy.created_at
           FROM turns_legacy_v1 AS legacy
           LEFT JOIN conversations AS conversation ON conversation.id = legacy.conversation_id`,
				);
				this.db.exec("DROP TABLE turns_legacy_v1");
			}

			this.db
				.query(
					`INSERT INTO meta (key, value) VALUES ($key, $value)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				)
				.run({ $key: "schema_version", $value: "2" });
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}

	createConversation(row: ConversationRow): void {
		this.db
			.query(
				`INSERT INTO conversations
          (id, branch, base_branch, base_commit, status, harness_id, model, effort, created_at, updated_at)
         VALUES ($id, $branch, $base_branch, $base_commit, $status, $harness_id, $model, $effort, $created_at, $updated_at)`,
			)
			.run({
				$id: row.id,
				$branch: row.branch,
				$base_branch: row.base_branch,
				$base_commit: row.base_commit,
				$status: row.status,
				$harness_id: row.harness_id,
				$model: row.model,
				$effort: row.effort,
				$created_at: row.created_at,
				$updated_at: row.updated_at,
			});
	}

	getConversation(id: string): ConversationRow | null {
		return this.db
			.query("SELECT * FROM conversations WHERE id = $id")
			.get({ $id: id }) as ConversationRow | null;
	}

	setConversationConfig(
		id: string,
		patch: { harness_id?: string; model?: string; effort?: string },
	): void {
		const cols = Object.keys(patch) as (keyof typeof patch)[];
		if (cols.length === 0) return;
		const sets = cols.map((c) => `${c} = $${c}`).join(", ");
		const params: Record<string, string | number> = {
			$id: id,
			$now: Date.now(),
		};
		for (const c of cols) params[`$${c}`] = patch[c] ?? "";
		this.db
			.query(
				`UPDATE conversations SET ${sets}, updated_at = $now WHERE id = $id`,
			)
			.run(params);
	}

	deleteConversation(id: string): void {
		this.db
			.query("DELETE FROM turns WHERE conversation_id = $id")
			.run({ $id: id });
		this.db.query("DELETE FROM conversations WHERE id = $id").run({ $id: id });
	}

	listConversations(): ConversationSummary[] {
		return this.db
			.query(
				`SELECT
           c.id AS id,
           c.branch AS branch,
           c.status AS status,
           c.created_at AS createdAt,
           c.updated_at AS updatedAt,
           c.harness_id AS harnessId,
           c.model AS model,
           c.effort AS effort,
           (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turnCount,
           (SELECT prompt FROM turns t WHERE t.conversation_id = c.id ORDER BY seq ASC LIMIT 1) AS title,
           'idle' AS turnState,
           NULL AS queuePosition
         FROM conversations c
         ORDER BY c.updated_at DESC`,
			)
			.all() as ConversationSummary[];
	}

	setConversationStatus(id: string, status: string): void {
		this.db
			.query(
				"UPDATE conversations SET status = $status, updated_at = $now WHERE id = $id",
			)
			.run({ $status: status, $now: Date.now(), $id: id });
	}

	touchConversation(id: string): void {
		this.db
			.query("UPDATE conversations SET updated_at = $now WHERE id = $id")
			.run({ $now: Date.now(), $id: id });
	}

	addTurn(row: NewTurnRow): number {
		const res = this.db
			.query(
				`INSERT INTO turns
          (conversation_id, seq, prompt, source, dom_context, harness_id, resume_token,
           checkpoint, parent_checkpoint, output, blocks, status, created_at)
         VALUES
          ($conversation_id, $seq, $prompt, $source, $dom_context, $harness_id, $resume_token,
           $checkpoint, $parent_checkpoint, $output, $blocks, $status, $created_at)`,
			)
			.run({
				$conversation_id: row.conversation_id,
				$seq: row.seq,
				$prompt: row.prompt,
				$source: row.source,
				$dom_context: row.dom_context,
				$harness_id: row.harness_id,
				$resume_token: row.resume_token,
				$checkpoint: row.checkpoint,
				$parent_checkpoint: row.parent_checkpoint,
				$output: row.output,
				$blocks: row.blocks,
				$status: row.status,
				$created_at: row.created_at,
			});
		return Number(res.lastInsertRowid);
	}

	getTurns(conversationId: string): TurnRow[] {
		return this.db
			.query("SELECT * FROM turns WHERE conversation_id = $c ORDER BY seq ASC")
			.all({ $c: conversationId }) as TurnRow[];
	}

	/** Highest-seq turn not reverted/cancelled/errored — the current branch tip owner. */
	lastActiveTurn(conversationId: string): TurnRow | null {
		return this.db
			.query(
				`SELECT * FROM turns
         WHERE conversation_id = $c AND status NOT IN ('reverted', 'cancelled', 'error')
         ORDER BY seq DESC LIMIT 1`,
			)
			.get({ $c: conversationId }) as TurnRow | null;
	}
	updateTurn(id: number, patch: TurnPatch): void {
		const allowedColumns: (keyof TurnPatch)[] = [
			"harness_id",
			"resume_token",
			"checkpoint",
			"parent_checkpoint",
			"output",
			"blocks",
			"status",
		];
		const columns = allowedColumns.filter((column) =>
			Object.hasOwn(patch, column),
		);
		if (columns.length === 0) return;

		// A token belongs to the Harness that issued it. Reassigning ownership
		// without an explicit replacement token must invalidate the old token.
		const invalidatesResumeToken =
			columns.includes("harness_id") && !columns.includes("resume_token");
		if (invalidatesResumeToken) columns.push("resume_token");

		const sets = columns.map((column) => `${column} = $${column}`).join(", ");
		const params: Record<string, string | number | null> = { $id: id };
		for (const column of columns) {
			params[`$${column}`] =
				invalidatesResumeToken && column === "resume_token"
					? null
					: (patch[column] ?? null);
		}
		this.db.query(`UPDATE turns SET ${sets} WHERE id = $id`).run(params);
	}

	setTurnStatus(id: number, status: string): void {
		this.db
			.query("UPDATE turns SET status = $status WHERE id = $id")
			.run({ $status: status, $id: id });
	}
}
