import type { Database } from "bun:sqlite";
import {
	CONVERSATIONS_TABLE,
	INDEXES,
	META_TABLE,
	SCHEMA_VERSION,
	TURNS_TABLE,
} from "./schema";

interface TableColumn {
	name: string;
}

function tableExists(db: Database, table: string): boolean {
	return Boolean(
		db
			.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name")
			.get({ $name: table }),
	);
}

function tableColumns(db: Database, table: string): Set<string> {
	const rows = db.query(`PRAGMA table_info(${table})`).all() as TableColumn[];
	return new Set(rows.map((row) => row.name));
}

function column(
	columns: Set<string>,
	name: string,
	fallback: string,
	prefix = "legacy",
): string {
	return columns.has(name) ? `${prefix}.${name}` : fallback;
}

function hasCurrentConstraints(db: Database): boolean {
	if (!tableExists(db, "turns")) return false;
	const foreignKeys = db.query("PRAGMA foreign_key_list(turns)").all() as {
		table: string;
		on_delete: string;
	}[];
	const indexes = db.query("PRAGMA index_list(turns)").all() as {
		unique: number;
		name: string;
	}[];
	const turnTable = db
		.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'")
		.get() as { sql: string } | null;
	const conversationTable = db
		.query(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'",
		)
		.get() as { sql: string } | null;
	return (
		Boolean(turnTable?.sql.includes("'reverted'")) &&
		Boolean(conversationTable?.sql.includes("'discarded'")) &&
		foreignKeys.some(
			(key) => key.table === "conversations" && key.on_delete === "CASCADE",
		) &&
		indexes.some((index) => {
			if (!index.unique) return false;
			const columns = db.query(`PRAGMA index_info(${index.name})`).all() as {
				name: string;
			}[];
			return columns.map((item) => item.name).join(",") === "conversation_id,seq";
		})
	);
}

function setVersion(db: Database): void {
	db.query(
		`INSERT INTO meta (key, value) VALUES ('schema_version', $value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run({ $value: SCHEMA_VERSION });
}

function createCurrentSchema(db: Database): void {
	db.exec(`${CONVERSATIONS_TABLE};${TURNS_TABLE};${INDEXES}`);
	setVersion(db);
}

export function migrateHistorySchema(db: Database): void {
	db.exec(META_TABLE);
	if (!tableExists(db, "conversations") && !tableExists(db, "turns")) {
		createCurrentSchema(db);
		return;
	}
	if (hasCurrentConstraints(db)) {
		db.exec(INDEXES);
		setVersion(db);
		return;
	}

	const conversationColumns = tableColumns(db, "conversations");
	const turnColumns = tableColumns(db, "turns");
	const harness = conversationColumns.has("harness_id")
		? conversationColumns.has("agent_id")
			? "COALESCE(NULLIF(legacy.harness_id, ''), legacy.agent_id, '')"
			: "COALESCE(legacy.harness_id, '')"
		: conversationColumns.has("agent_id")
			? "COALESCE(legacy.agent_id, '')"
			: "''";
	const turnHarness = turnColumns.has("harness_id")
		? "COALESCE(NULLIF(legacy.harness_id, ''), conversation.harness_id, '')"
		: "COALESCE(conversation.harness_id, '')";
	const resumeToken =
		turnColumns.has("resume_token") && turnColumns.has("harness_id")
			? "CASE WHEN legacy.harness_id <> '' THEN legacy.resume_token ELSE NULL END"
			: "NULL";

	db.exec("PRAGMA foreign_keys = OFF");
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec("ALTER TABLE conversations RENAME TO conversations_legacy");
		db.exec("ALTER TABLE turns RENAME TO turns_legacy");
		db.exec(CONVERSATIONS_TABLE);
		db.exec(TURNS_TABLE);
		db.exec(`
      INSERT INTO conversations
        (id, branch, base_branch, base_commit, status, harness_id, model, effort, created_at, updated_at)
      SELECT legacy.id, legacy.branch, legacy.base_branch, legacy.base_commit,
             CASE WHEN legacy.status IN ('active', 'accepted', 'discarded')
                  THEN legacy.status ELSE 'active' END,
             ${harness}, ${column(conversationColumns, "model", "''")},
             ${column(conversationColumns, "effort", "''")}, legacy.created_at, legacy.updated_at
      FROM conversations_legacy AS legacy`);
		db.exec(`
      INSERT INTO turns
        (id, conversation_id, seq, prompt, source, dom_context, harness_id, resume_token,
         checkpoint, parent_checkpoint, output, blocks, status, created_at)
      SELECT legacy.id, legacy.conversation_id,
             ROW_NUMBER() OVER (PARTITION BY legacy.conversation_id ORDER BY legacy.seq, legacy.id),
             legacy.prompt, legacy.source, legacy.dom_context, ${turnHarness}, ${resumeToken},
             ${column(turnColumns, "checkpoint", "NULL")},
             ${column(turnColumns, "parent_checkpoint", "NULL")},
             ${column(turnColumns, "output", "NULL")},
             ${column(turnColumns, "blocks", "NULL")},
             CASE WHEN legacy.status IN ('running', 'complete', 'error', 'cancelled', 'reverted')
                  THEN legacy.status ELSE 'error' END,
             legacy.created_at
      FROM turns_legacy AS legacy
      JOIN conversations AS conversation ON conversation.id = legacy.conversation_id`);
		db.exec("DROP TABLE turns_legacy");
		db.exec("DROP TABLE conversations_legacy");
		db.exec(INDEXES);
		setVersion(db);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
}
