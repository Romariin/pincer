import type { Database } from "bun:sqlite";
import type { ConversationStatus, ConversationSummary, TurnStatus } from "@pincer/core";
import type {
	ConversationRow,
	NewTurnRow,
	TurnPatch,
	TurnRow,
} from "./types";

export class ConversationRepository {
	constructor(private readonly db: Database) {}

	create(row: ConversationRow): void {
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

	get(id: string): ConversationRow | null {
		return this.db
			.query("SELECT * FROM conversations WHERE id = $id")
			.get({ $id: id }) as ConversationRow | null;
	}

	setConfig(
		id: string,
		patch: { harness_id?: string; model?: string; effort?: string },
	): void {
		const columns = Object.keys(patch) as (keyof typeof patch)[];
		if (columns.length === 0) return;
		const sets = columns.map((item) => `${item} = $${item}`).join(", ");
		const params: Record<string, string | number> = {
			$id: id,
			$now: Date.now(),
		};
		for (const item of columns) params[`$${item}`] = patch[item] ?? "";
		this.db
			.query(
				`UPDATE conversations SET ${sets}, updated_at = $now WHERE id = $id`,
			)
			.run(params);
	}

	delete(id: string): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.query("DELETE FROM conversations WHERE id = $id").run({ $id: id });
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	list(): ConversationSummary[] {
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
           COUNT(t.id) AS turnCount,
           (SELECT first.prompt FROM turns first WHERE first.conversation_id = c.id ORDER BY first.seq LIMIT 1) AS title,
           'idle' AS turnState,
           NULL AS queuePosition
         FROM conversations c
         LEFT JOIN turns t ON t.conversation_id = c.id
         GROUP BY c.id
         ORDER BY c.updated_at DESC`,
			)
			.all() as ConversationSummary[];
	}

	setStatus(id: string, status: ConversationStatus): void {
		this.db
			.query(
				"UPDATE conversations SET status = $status, updated_at = $now WHERE id = $id",
			)
			.run({ $status: status, $now: Date.now(), $id: id });
	}

	touch(id: string): void {
		this.db
			.query("UPDATE conversations SET updated_at = $now WHERE id = $id")
			.run({ $now: Date.now(), $id: id });
	}
}

export class TurnRepository {
	constructor(private readonly db: Database) {}

	append(row: NewTurnRow): { id: number; seq: number } {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const next = this.db
				.query(
					"SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turns WHERE conversation_id = $id",
				)
				.get({ $id: row.conversation_id }) as { seq: number };
			const result = this.db
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
					$seq: next.seq,
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
			this.db
				.query("UPDATE conversations SET updated_at = $now WHERE id = $id")
				.run({ $now: Date.now(), $id: row.conversation_id });
			this.db.exec("COMMIT");
			return { id: Number(result.lastInsertRowid), seq: next.seq };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	getForConversation(conversationId: string): TurnRow[] {
		return this.db
			.query("SELECT * FROM turns WHERE conversation_id = $id ORDER BY seq")
			.all({ $id: conversationId }) as TurnRow[];
	}

	lastActive(conversationId: string): TurnRow | null {
		return this.db
			.query(
				`SELECT * FROM turns
         WHERE conversation_id = $id AND status NOT IN ('reverted', 'cancelled', 'error')
         ORDER BY seq DESC LIMIT 1`,
			)
			.get({ $id: conversationId }) as TurnRow | null;
	}

	update(id: number, patch: TurnPatch): void {
		const allowed: (keyof TurnPatch)[] = [
			"harness_id",
			"resume_token",
			"checkpoint",
			"parent_checkpoint",
			"output",
			"blocks",
			"status",
		];
		const columns = allowed.filter((item) => Object.hasOwn(patch, item));
		if (columns.length === 0) return;
		const invalidatesToken =
			columns.includes("harness_id") && !columns.includes("resume_token");
		if (invalidatesToken) columns.push("resume_token");
		const sets = columns.map((item) => `${item} = $${item}`).join(", ");
		const params: Record<string, string | number | null> = { $id: id };
		for (const item of columns) {
			params[`$${item}`] =
				invalidatesToken && item === "resume_token"
					? null
					: (patch[item] ?? null);
		}
		this.db.query(`UPDATE turns SET ${sets} WHERE id = $id`).run(params);
	}

	setStatus(id: number, status: TurnStatus): void {
		this.db
			.query("UPDATE turns SET status = $status WHERE id = $id")
			.run({ $status: status, $id: id });
	}
}
