import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	ConversationStatus,
	ConversationSummary,
	TurnStatus,
} from "@pincer/core";
import { migrateHistorySchema } from "./storage/migrations";
import {
	ConversationRepository,
	TurnRepository,
} from "./storage/repositories";
import type {
	ConversationRow,
	NewTurnRow,
	TurnPatch,
	TurnRow,
} from "./storage/types";

export type {
	ConversationRow,
	NewTurnRow,
	TurnPatch,
	TurnRow,
} from "./storage/types";

/** Persistent conversation/turn history at an explicit user-data database path. */
export class Store {
	private readonly db: Database;
	private readonly conversations: ConversationRepository;
	private readonly turns: TurnRepository;

	constructor(historyDbPath: string) {
		mkdirSync(dirname(historyDbPath), { recursive: true });
		this.db = new Database(historyDbPath);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		migrateHistorySchema(this.db);
		this.conversations = new ConversationRepository(this.db);
		this.turns = new TurnRepository(this.db);
		this.db
			.query("UPDATE turns SET status = 'error' WHERE status = 'running'")
			.run();
	}

	close(): void {
		this.db.close();
	}

	createConversation(row: ConversationRow): void {
		this.conversations.create(row);
	}

	getConversation(id: string): ConversationRow | null {
		return this.conversations.get(id);
	}

	setConversationConfig(
		id: string,
		patch: { harness_id?: string; model?: string; effort?: string },
	): void {
		this.conversations.setConfig(id, patch);
	}

	deleteConversation(id: string): void {
		this.conversations.delete(id);
	}

	listConversations(): ConversationSummary[] {
		return this.conversations.list();
	}

	setConversationStatus(id: string, status: ConversationStatus): void {
		this.conversations.setStatus(id, status);
	}

	touchConversation(id: string): void {
		this.conversations.touch(id);
	}

	appendTurn(row: NewTurnRow): { id: number; seq: number } {
		return this.turns.append(row);
	}

	getTurns(conversationId: string): TurnRow[] {
		return this.turns.getForConversation(conversationId);
	}

	lastActiveTurn(conversationId: string): TurnRow | null {
		return this.turns.lastActive(conversationId);
	}

	updateTurn(id: number, patch: TurnPatch): void {
		this.turns.update(id, patch);
	}

	setTurnStatus(id: number, status: TurnStatus): void {
		this.turns.setStatus(id, status);
	}
}
