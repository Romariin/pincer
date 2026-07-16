import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ConversationSummary } from "@pincer/core";

export interface ConversationRow {
  id: string;
  branch: string;
  base_branch: string;
  base_commit: string;
  status: string;
  agent_id: string;
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
  agent_session_id: string | null;
  checkpoint: string | null;
  parent_checkpoint: string | null;
  output: string | null;
  blocks: string | null;
  status: string;
  created_at: number;
}

export type NewTurnRow = Omit<TurnRow, "id">;
export type TurnPatch = Partial<
  Pick<TurnRow, "agent_session_id" | "checkpoint" | "parent_checkpoint" | "output" | "blocks" | "status">
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  harness_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
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
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Persistent conversation/turn history in `<projectRoot>/.pincer/history.db`. */
export class Store {
  private readonly db: Database;

  constructor(projectRoot: string) {
    const dir = join(projectRoot, ".pincer");
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "history.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    for (const col of ["harness_id", "model", "effort"]) {
      try {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
      } catch {
        /* column already present */
      }
    }
    try {
      this.db.exec("ALTER TABLE turns ADD COLUMN blocks TEXT");
    } catch {
      /* column already present */
    }
    this.db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  }

  close(): void {
    this.db.close();
  }

  createConversation(row: ConversationRow): void {
    this.db
      .query(
        `INSERT INTO conversations
          (id, branch, base_branch, base_commit, status, agent_id, harness_id, model, effort, created_at, updated_at)
         VALUES ($id, $branch, $base_branch, $base_commit, $status, $agent_id, $harness_id, $model, $effort, $created_at, $updated_at)`,
      )
      .run({
        $id: row.id,
        $branch: row.branch,
        $base_branch: row.base_branch,
        $base_commit: row.base_commit,
        $status: row.status,
        $agent_id: row.agent_id,
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

  setConversationConfig(id: string, patch: { harness_id?: string; model?: string; effort?: string }): void {
    const cols = Object.keys(patch) as (keyof typeof patch)[];
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = $${c}`).join(", ");
    const params: Record<string, string | number> = { $id: id, $now: Date.now() };
    for (const c of cols) params[`$${c}`] = patch[c] ?? "";
    this.db.query(`UPDATE conversations SET ${sets}, updated_at = $now WHERE id = $id`).run(params);
  }

  deleteConversation(id: string): void {
    this.db.query("DELETE FROM turns WHERE conversation_id = $id").run({ $id: id });
    this.db.query("DELETE FROM conversations WHERE id = $id").run({ $id: id });
  }

  listConversations(): ConversationSummary[] {
    return this.db
      .query(
        `SELECT
           c.id AS id,
           c.branch AS branch,
           c.status AS status,
           c.agent_id AS agentId,
           c.created_at AS createdAt,
           c.updated_at AS updatedAt,
           c.harness_id AS harnessId,
           c.model AS model,
           c.effort AS effort,
           (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turnCount,
           (SELECT prompt FROM turns t WHERE t.conversation_id = c.id ORDER BY seq ASC LIMIT 1) AS title
         FROM conversations c
         ORDER BY c.updated_at DESC`,
      )
      .all() as ConversationSummary[];
  }

  setConversationStatus(id: string, status: string): void {
    this.db
      .query("UPDATE conversations SET status = $status, updated_at = $now WHERE id = $id")
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
          (conversation_id, seq, prompt, source, dom_context, agent_session_id,
           checkpoint, parent_checkpoint, output, blocks, status, created_at)
         VALUES
          ($conversation_id, $seq, $prompt, $source, $dom_context, $agent_session_id,
           $checkpoint, $parent_checkpoint, $output, $blocks, $status, $created_at)`,
      )
      .run({
        $conversation_id: row.conversation_id,
        $seq: row.seq,
        $prompt: row.prompt,
        $source: row.source,
        $dom_context: row.dom_context,
        $agent_session_id: row.agent_session_id,
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
    const cols = Object.keys(patch) as (keyof TurnPatch)[];
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = $${c}`).join(", ");
    const params: Record<string, string | number | null> = { $id: id };
    for (const c of cols) params[`$${c}`] = patch[c] ?? null;
    this.db.query(`UPDATE turns SET ${sets} WHERE id = $id`).run(params);
  }

  setTurnStatus(id: number, status: string): void {
    this.db.query("UPDATE turns SET status = $status WHERE id = $id").run({ $status: status, $id: id });
  }
}
