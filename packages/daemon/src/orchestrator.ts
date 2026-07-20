import {
	PROTOCOL_VERSION,
	type ConversationConfig,
	type ConversationSummary,
	type DiffHunk,
	type DomContext,
	type HarnessEvent,
	type MessageBlock,
	type PromptElement,
	type ServerMessage,
	type SourceLocation,
	type TurnSummary,
} from "@pincer/core";
import type { Git } from "./git";
import { HarnessRunner } from "./harnesses/runner";
import type { InstalledHarness } from "./harnesses/types";
import type { ConversationRow, Store, TurnRow } from "./store";
import { TurnScheduler } from "./turnScheduler";
import type { TurnExecutionControls, TurnSubmission } from "./turnScheduler";

export type Emit = (message: ServerMessage) => void;

export interface OrchestratorDeps {
	git: Git;
	store: Store;
	projectRoot: string;
	pincerDataDir: string;
	harnesses: InstalledHarness[];
	defaultHarnessId: string | null;
	publish: Emit;
	log?: (message: string) => void;
}

const NO_HARNESS_HINT =
	"No coding Harness is available. Install Claude Code, Codex, or OMP, or configure a Harness command.";
const MAX_DIFF_FILES = 8;
const MAX_DIFF_LINES = 240;

/** Composes persistence, HarnessRunner, and TurnScheduler for direct-edit conversations. */
export class Orchestrator {
	private readonly git: Git;
	private readonly store: Store;
	private readonly projectRoot: string;
	private readonly pincerDataDir: string;
	private readonly harnesses: InstalledHarness[];
	private readonly configuredDefaultHarnessId: string | null;
	private readonly publish: Emit;
	private readonly log: (message: string) => void;
	private readonly runner = new HarnessRunner();
	private readonly scheduler: TurnScheduler;

	constructor(deps: OrchestratorDeps) {
		this.git = deps.git;
		this.store = deps.store;
		this.projectRoot = deps.projectRoot;
		this.pincerDataDir = deps.pincerDataDir;
		this.harnesses = deps.harnesses;
		this.configuredDefaultHarnessId = deps.defaultHarnessId;
		this.publish = deps.publish;
		this.log = deps.log ?? (() => {});
		this.scheduler = new TurnScheduler({
			publish: this.publish,
			execute: (submission, controls) => this.executeTurn(submission, controls),
			persistQueuedCancellation: (submission) =>
				this.persistQueuedCancellation(submission),
			onStateChanged: () => this.publish(this.listConversations()),
		});
	}

	get defaultHarnessId(): string | null {
		return this.configuredDefaultHarnessId;
	}

	listConversations(): ServerMessage {
		const items = this.store.listConversations().map((conversation) => {
			const live = this.scheduler.stateFor(conversation.id);
			return {
				...conversation,
				turnState: live.state,
				queuePosition: live.queuePosition,
			};
		});
		return { v: PROTOCOL_VERSION, type: "conversations", items };
	}

	async newConversation(config: ConversationConfig): Promise<ServerMessage> {
		const selectedId = config.harnessId ?? this.defaultHarnessId;
		if (!selectedId) {
			return {
				v: PROTOCOL_VERSION,
				type: "blocked",
				reason: "harness_unavailable",
				message: NO_HARNESS_HINT,
			};
		}
		const harness = this.harnesses.find(
			({ definition }) => definition.id === selectedId,
		);
		if (!harness) return this.unknownHarness(selectedId);
		if (!harness.detected) return this.unavailableHarness(selectedId);

		const model = config.model || harness.models[0]?.id;
		if (!model) return this.unavailableHarness(selectedId);
		const effort = config.effort ?? "";

		const id = crypto.randomUUID().slice(0, 8);
		const branch = await this.git.currentBranch();
		const now = Date.now();
		this.store.createConversation({
			id,
			branch,
			base_branch: branch,
			base_commit: "",
			status: "active",
			harness_id: selectedId,
			model,
			effort,
			created_at: now,
			updated_at: now,
		});

		const row = this.store.getConversation(id);
		if (!row) throw new Error("Conversation vanished after creation.");
		return {
			v: PROTOCOL_VERSION,
			type: "conversation_started",
			conversation: this.toSummary(row),
		};
	}

	resumeConversation(id: string): ServerMessage {
		const conversation = this.store.getConversation(id);
		if (!conversation) return this.unknownConversation();
		return {
			v: PROTOCOL_VERSION,
			type: "conversation_resumed",
			conversation: this.toSummary(conversation),
			turns: this.store.getTurns(id).map(toTurnSummary),
			liveTurn: this.scheduler.snapshot(id),
		};
	}

	setConfig(conversationId: string, config: ConversationConfig): ServerMessage {
		const conversation = this.store.getConversation(conversationId);
		if (!conversation) return this.unknownConversation();
		if (this.scheduler.hasOutstanding(conversationId)) {
			return {
				v: PROTOCOL_VERSION,
				type: "blocked",
				reason: "outstanding_turn",
				conversationId,
				message:
					"Harness controls cannot change while this conversation has an outstanding turn.",
			};
		}

		if (config.harnessId !== undefined) {
			const harness = this.harnesses.find(
				({ definition }) => definition.id === config.harnessId,
			);
			if (!harness)
				return this.unknownHarness(config.harnessId, conversationId);
			if (!harness.detected)
				return this.unavailableHarness(config.harnessId, conversationId);
		}

		const patch: { harness_id?: string; model?: string; effort?: string } = {};
		if (config.harnessId !== undefined) patch.harness_id = config.harnessId;
		if (config.model !== undefined) patch.model = config.model;
		if (config.effort !== undefined) patch.effort = config.effort;
		this.store.setConversationConfig(conversationId, patch);
		const updated = this.store.getConversation(conversationId);
		if (!updated)
			throw new Error(
				"Conversation vanished after its Harness configuration changed.",
			);
		return {
			v: PROTOCOL_VERSION,
			type: "config_updated",
			conversation: this.toSummary(updated),
		};
	}

	submitTurn(
		conversationId: string,
		prompt: string,
		source: SourceLocation | null,
		domContext: DomContext,
		elements: PromptElement[],
	): ServerMessage | null {
		const conversation = this.store.getConversation(conversationId);
		if (!conversation) return this.unknownConversation();
		if (this.scheduler.hasOutstanding(conversationId)) {
			return {
				v: PROTOCOL_VERSION,
				type: "blocked",
				reason: "outstanding_turn",
				conversationId,
				message: "This conversation already has a queued or running turn.",
			};
		}

		const harness = this.harnesses.find(
			({ definition }) => definition.id === conversation.harness_id,
		);
		if (!harness)
			return this.unknownHarness(conversation.harness_id, conversationId);
		if (!harness.detected)
			return this.unavailableHarness(conversation.harness_id, conversationId);

		const accepted = this.scheduler.submit({
			conversationId,
			prompt,
			source,
			domContext,
			elements,
			selection: {
				harnessId: conversation.harness_id,
				model: conversation.model,
				effort: conversation.effort,
			},
		});
		if (accepted) return null;
		return {
			v: PROTOCOL_VERSION,
			type: "blocked",
			reason: "busy",
			conversationId,
			message: "Pincer is shutting down.",
		};
	}

	async cancel(conversationId: string): Promise<void> {
		await this.scheduler.cancel(conversationId);
	}

	async deleteConversation(conversationId: string): Promise<ServerMessage> {
		const conversation = this.store.getConversation(conversationId);
		if (!conversation) return this.unknownConversation();
		await this.scheduler.cancel(conversationId);
		this.store.deleteConversation(conversationId);
		return { v: PROTOCOL_VERSION, type: "deleted", conversationId };
	}

	async stop(): Promise<void> {
		await this.scheduler.stop();
	}

	async revert(conversationId: string): Promise<ServerMessage> {
		if (!this.store.getConversation(conversationId))
			return this.unknownConversation();
		return {
			v: PROTOCOL_VERSION,
			type: "error",
			message:
				"Revert is unavailable in direct-edit mode; undo the file change with your editor or git.",
		};
	}

	async accept(conversationId: string): Promise<ServerMessage> {
		if (!this.store.getConversation(conversationId))
			return this.unknownConversation();
		this.store.setConversationStatus(conversationId, "accepted");
		return {
			v: PROTOCOL_VERSION,
			type: "accepted",
			conversationId,
			mergeCommit: "",
		};
	}

	async discard(conversationId: string): Promise<ServerMessage> {
		if (!this.store.getConversation(conversationId))
			return this.unknownConversation();
		this.store.setConversationStatus(conversationId, "discarded");
		return { v: PROTOCOL_VERSION, type: "discarded", conversationId };
	}

	private persistQueuedCancellation(submission: TurnSubmission): number {
		const turns = this.store.getTurns(submission.conversationId);
		const turnId = this.store.addTurn({
			conversation_id: submission.conversationId,
			seq: turns.length + 1,
			prompt: submission.prompt,
			source: submission.source ? JSON.stringify(submission.source) : null,
			dom_context: JSON.stringify(submission.domContext),
			harness_id: submission.selection.harnessId,
			resume_token: null,
			checkpoint: null,
			parent_checkpoint: null,
			output: null,
			blocks: JSON.stringify([]),
			status: "cancelled",
			created_at: Date.now(),
		});
		this.store.touchConversation(submission.conversationId);
		return turnId;
	}

	private async executeTurn(
		submission: TurnSubmission,
		controls: TurnExecutionControls,
	): Promise<void> {
		const harness = this.harnesses.find(
			({ definition }) => definition.id === submission.selection.harnessId,
		);
		if (!harness?.detected)
			throw new Error(
				`Harness became unavailable: ${submission.selection.harnessId}`,
			);

		const beforeDiff = await this.snapshotDiff();
		const turns = this.store.getTurns(submission.conversationId);
		const seq = turns.length + 1;
		let resumeToken: string | null = null;
		for (let index = turns.length - 1; index >= 0; index -= 1) {
			const turn = turns[index];
			if (!turn || turn.harness_id !== submission.selection.harnessId) break;
			if (turn.status !== "complete") continue;
			resumeToken = turn.resume_token;
			break;
		}

		const turnId = this.store.addTurn({
			conversation_id: submission.conversationId,
			seq,
			prompt: submission.prompt,
			source: submission.source ? JSON.stringify(submission.source) : null,
			dom_context: JSON.stringify(submission.domContext),
			harness_id: submission.selection.harnessId,
			resume_token: null,
			checkpoint: null,
			parent_checkpoint: null,
			output: null,
			blocks: null,
			status: "running",
			created_at: Date.now(),
		});
		controls.started(turnId, seq);

		if (controls.cancellationRequested) {
			this.store.setTurnStatus(turnId, "cancelled");
			this.publish({
				v: PROTOCOL_VERSION,
				type: "turn_cancelled",
				conversationId: submission.conversationId,
				turnId,
			});
			return;
		}

		this.log(
			`turn started harness=${submission.selection.harnessId} model=${submission.selection.model || "default"} effort=${submission.selection.effort || "default"} conversation=${submission.conversationId} turn=${seq}`,
		);
		const running = this.runner.start(
			harness,
			{
				prompt: submission.prompt,
				source: submission.source,
				domContext: submission.domContext,
				elements: submission.elements,
				projectRoot: this.projectRoot,
				pincerDataDir: this.pincerDataDir,
				conversationId: submission.conversationId,
				selection: submission.selection,
				resumeToken,
			},
			controls.event,
		);
		controls.setCancel(running.cancel);
		const outcome = await running.outcome;
		for (const diagnostic of outcome.diagnostics) {
			this.log(
				`Harness diagnostic conversation=${submission.conversationId} turn=${seq}: ${diagnostic}`,
			);
		}

		if (outcome.status === "cancelled" || controls.cancellationRequested) {
			const snapshot = controls.snapshot();
			this.store.updateTurn(turnId, {
				output: outputFromBlocks(snapshot.blocks),
				blocks: JSON.stringify(snapshot.blocks),
				status: "cancelled",
			});
			this.publish({
				v: PROTOCOL_VERSION,
				type: "turn_cancelled",
				conversationId: submission.conversationId,
				turnId,
			});
			return;
		}

		if (outcome.status === "failed") {
			const snapshot = controls.snapshot();
			this.store.updateTurn(turnId, {
				output: outputFromBlocks(snapshot.blocks),
				blocks: JSON.stringify(snapshot.blocks),
				status: "error",
			});
			this.publish({
				v: PROTOCOL_VERSION,
				type: "turn_error",
				conversationId: submission.conversationId,
				turnId,
				message: outcome.summary,
			});
			return;
		}

		for (const diff of await this.collectDiffs(beforeDiff))
			controls.event(diff);
		if (controls.cancellationRequested) {
			this.store.setTurnStatus(turnId, "cancelled");
			this.publish({
				v: PROTOCOL_VERSION,
				type: "turn_cancelled",
				conversationId: submission.conversationId,
				turnId,
			});
			return;
		}

		const snapshot = controls.snapshot();
		const output = outputFromBlocks(snapshot.blocks);
		this.store.updateTurn(turnId, {
			resume_token: outcome.sessionToken,
			checkpoint: null,
			parent_checkpoint: null,
			output,
			blocks: JSON.stringify(snapshot.blocks),
			status: "complete",
		});
		this.store.touchConversation(submission.conversationId);
		const summary = outcome.summary || output.trim().slice(0, 200) || "done";
		this.publish({
			v: PROTOCOL_VERSION,
			type: "turn_complete",
			conversationId: submission.conversationId,
			turnId,
			checkpoint: null,
			success: true,
			summary,
		});
		this.log(
			`turn complete conversation=${submission.conversationId} turn=${seq}`,
		);
	}

	private async snapshotDiff(): Promise<Map<string, DiffHunk[]>> {
		const snapshot = new Map<string, DiffHunk[]>();
		try {
			for (const block of parseUnifiedDiff(await this.git.rawDiff()))
				snapshot.set(block.file, block.hunks);
		} catch {
			/* Git diff is optional for Harness execution. */
		}
		return snapshot;
	}

	private async collectDiffs(
		before: Map<string, DiffHunk[]>,
	): Promise<Extract<HarnessEvent, { kind: "diff" }>[]> {
		let after: Extract<HarnessEvent, { kind: "diff" }>[];
		try {
			after = parseUnifiedDiff(await this.git.rawDiff());
		} catch {
			return [];
		}

		return after
			.map((block) => {
				const priorCounts = new Map<string, number>();
				for (const hunk of before.get(block.file) ?? []) {
					const key = `${hunk.type}\u0000${hunk.text}`;
					priorCounts.set(key, (priorCounts.get(key) ?? 0) + 1);
				}
				const hunks = block.hunks.filter((hunk) => {
					const key = `${hunk.type}\u0000${hunk.text}`;
					const count = priorCounts.get(key) ?? 0;
					if (count === 0) return true;
					priorCounts.set(key, count - 1);
					return false;
				});
				return { ...block, hunks };
			})
			.filter((block) => block.hunks.length > 0)
			.slice(0, MAX_DIFF_FILES);
	}

	private toSummary(row: ConversationRow): ConversationSummary {
		const turns = this.store.getTurns(row.id);
		const live = this.scheduler.stateFor(row.id);
		return {
			id: row.id,
			branch: row.branch,
			status: row.status,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			turnCount: turns.length,
			title: turns[0]?.prompt ?? null,
			harnessId: row.harness_id,
			model: row.model,
			effort: row.effort,
			turnState: live.state,
			queuePosition: live.queuePosition,
		};
	}

	private unknownConversation(): ServerMessage {
		return {
			v: PROTOCOL_VERSION,
			type: "error",
			code: "unknown_conversation",
			message: "Unknown conversation.",
		};
	}

	private unknownHarness(
		harnessId: string,
		conversationId?: string,
	): ServerMessage {
		return {
			v: PROTOCOL_VERSION,
			type: "blocked",
			reason: "unknown_harness",
			conversationId,
			message: `Unknown Harness: ${harnessId}.`,
		};
	}

	private unavailableHarness(
		harnessId: string,
		conversationId?: string,
	): ServerMessage {
		return {
			v: PROTOCOL_VERSION,
			type: "blocked",
			reason: "harness_unavailable",
			conversationId,
			message: `Harness is unavailable: ${harnessId}.`,
		};
	}
}

function outputFromBlocks(blocks: MessageBlock[]): string {
	return blocks
		.filter(
			(block): block is Extract<MessageBlock, { t: "md" }> => block.t === "md",
		)
		.map((block) => block.text)
		.join("");
}

/** Parse git's unified diff into bounded browser blocks. */
function parseUnifiedDiff(
	raw: string,
): Extract<HarnessEvent, { kind: "diff" }>[] {
	if (!raw.trim()) return [];
	const files: Extract<HarnessEvent, { kind: "diff" }>[] = [];
	let current: Extract<HarnessEvent, { kind: "diff" }> | null = null;
	let inHunk = false;
	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git")) {
			current = { kind: "diff", file: "", hunks: [] };
			files.push(current);
			inHunk = false;
			continue;
		}
		if (!current) continue;
		if (line.startsWith("+++ b/")) {
			current.file = line.slice(6);
			continue;
		}
		if (line.startsWith("+++ ")) {
			current.file = line.slice(4).replace(/^b\//, "");
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk || current.hunks.length >= MAX_DIFF_LINES) continue;
		if (line.startsWith("+") && !line.startsWith("+++")) {
			current.hunks.push({ type: "add", text: line.slice(1) });
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			current.hunks.push({ type: "del", text: line.slice(1) });
		} else if (line.startsWith(" ")) {
			current.hunks.push({ type: "ctx", text: line.slice(1) });
		}
	}
	return files.filter((file) => file.file.length > 0 && file.hunks.length > 0);
}

function toTurnSummary(row: TurnRow): TurnSummary {
	let blocks: MessageBlock[] = [];
	if (row.blocks) {
		try {
			const parsed: unknown = JSON.parse(row.blocks);
			if (Array.isArray(parsed)) blocks = parsed as MessageBlock[];
		} catch {
			/* Corrupt legacy blocks fall back to accumulated text. */
		}
	}
	if (blocks.length === 0 && row.output)
		blocks = [{ t: "md", text: row.output }];
	return {
		id: row.id,
		seq: row.seq,
		prompt: row.prompt,
		checkpoint: row.checkpoint,
		status: row.status,
		createdAt: row.created_at,
		output: row.output ?? "",
		blocks,
	};
}
