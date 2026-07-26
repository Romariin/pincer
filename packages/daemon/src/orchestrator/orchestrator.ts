import {
	type ConversationConfig,
	type ConversationSummary,
	type DomContext,
	PROTOCOL_VERSION,
	type PromptElement,
	type ServerMessage,
	type SourceLocation,
} from "@pincer/core";
import { GitDiffCollector } from "../diffCollector";
import type { Git } from "../git";
import type { InstalledHarness } from "../harnesses/types";
import type { ConversationRow, Store } from "../store";
import { TurnScheduler } from "../turnScheduler";
import {
	harnessUnavailableBlocked,
	noHarnessBlocked,
	outstandingTurnBlocked,
	revertUnavailableError,
	shuttingDownBlocked,
	unknownConversationError,
	unknownHarnessBlocked,
} from "./messages";
import { conversationSummary, turnSummary } from "./summaries";
import { TurnExecution } from "./turnExecution";
import {
	persistCancelledQueuedTurn,
	persistUnexpectedTurnError,
} from "./turnPersistence";
import type { Emit, OrchestratorDeps } from "./types";

/** Composes persistence, HarnessRunner, and TurnScheduler for direct-edit conversations. */
export class Orchestrator {
	private readonly git: Git;
	private readonly store: Store;
	private readonly harnesses: InstalledHarness[];
	private readonly configuredDefaultHarnessId: string | null;
	private readonly publish: Emit;
	private readonly execution: TurnExecution;
	private readonly scheduler: TurnScheduler;

	constructor(deps: OrchestratorDeps) {
		this.git = deps.git;
		this.store = deps.store;
		this.harnesses = deps.harnesses;
		this.configuredDefaultHarnessId = deps.defaultHarnessId;
		this.publish = deps.publish;
		this.execution = new TurnExecution({
			store: deps.store,
			diffCollector: new GitDiffCollector(deps.git),
			findHarness: (harnessId) => this.findHarness(harnessId),
			projectRoot: deps.projectRoot,
			pincerDataDir: deps.pincerDataDir,
			publish: deps.publish,
			log: deps.log ?? (() => {}),
		});
		this.scheduler = new TurnScheduler({
			publish: this.publish,
			execute: (submission, controls) =>
				this.execution.run(submission, controls),
			persistQueuedCancellation: (submission) =>
				persistCancelledQueuedTurn(this.store, submission),
			persistUnexpectedError: (submission, snapshot, message) =>
				persistUnexpectedTurnError(this.store, submission, snapshot, message),
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
		if (!selectedId) return noHarnessBlocked();
		const harness = this.findHarness(selectedId);
		if (!harness) return unknownHarnessBlocked(selectedId);
		if (!harness.detected) return harnessUnavailableBlocked(selectedId);

		const model = config.model ?? "";
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
			conversation: this.summarize(row),
		};
	}

	resumeConversation(id: string): ServerMessage {
		const conversation = this.store.getConversation(id);
		if (!conversation) return unknownConversationError(id);
		return {
			v: PROTOCOL_VERSION,
			type: "conversation_resumed",
			conversation: this.summarize(conversation),
			turns: this.store.getTurns(id).map(turnSummary),
			liveTurn: this.scheduler.snapshot(id),
		};
	}

	setConfig(conversationId: string, config: ConversationConfig): ServerMessage {
		const conversation = this.store.getConversation(conversationId);
		if (!conversation) return unknownConversationError(conversationId);
		if (this.scheduler.hasOutstanding(conversationId)) {
			return outstandingTurnBlocked(
				conversationId,
				"Harness controls cannot change while this conversation has an outstanding turn.",
			);
		}

		if (config.harnessId !== undefined) {
			const harness = this.findHarness(config.harnessId);
			if (!harness)
				return unknownHarnessBlocked(config.harnessId, conversationId);
			if (!harness.detected)
				return harnessUnavailableBlocked(config.harnessId, conversationId);
		}

		const patch: { harness_id?: string; model?: string; effort?: string } = {};
		const harnessChanged =
			config.harnessId !== undefined &&
			config.harnessId !== conversation.harness_id;
		if (config.harnessId !== undefined) patch.harness_id = config.harnessId;
		if (config.model !== undefined) patch.model = config.model;
		else if (harnessChanged) patch.model = "";
		if (config.effort !== undefined) patch.effort = config.effort;
		else if (harnessChanged) patch.effort = "";
		this.store.setConversationConfig(conversationId, patch);
		const updated = this.store.getConversation(conversationId);
		if (!updated)
			throw new Error(
				"Conversation vanished after its Harness configuration changed.",
			);
		return {
			v: PROTOCOL_VERSION,
			type: "config_updated",
			conversation: this.summarize(updated),
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
		if (!conversation) return unknownConversationError(conversationId);
		if (this.scheduler.hasOutstanding(conversationId)) {
			return outstandingTurnBlocked(
				conversationId,
				"This conversation already has a queued or running turn.",
			);
		}

		const harness = this.findHarness(conversation.harness_id);
		if (!harness)
			return unknownHarnessBlocked(conversation.harness_id, conversationId);
		if (!harness.detected)
			return harnessUnavailableBlocked(conversation.harness_id, conversationId);

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
		return shuttingDownBlocked(conversationId);
	}

	async cancel(conversationId: string): Promise<void> {
		await this.scheduler.cancel(conversationId);
	}

	async deleteConversation(conversationId: string): Promise<ServerMessage> {
		const conversation = this.store.getConversation(conversationId);
		if (!conversation) return unknownConversationError(conversationId);
		await this.scheduler.cancel(conversationId);
		this.store.deleteConversation(conversationId);
		return { v: PROTOCOL_VERSION, type: "deleted", conversationId };
	}

	async stop(): Promise<void> {
		await this.scheduler.stop();
	}

	async revert(conversationId: string): Promise<ServerMessage> {
		if (!this.store.getConversation(conversationId))
			return unknownConversationError(conversationId);
		return revertUnavailableError();
	}

	async accept(conversationId: string): Promise<ServerMessage> {
		if (!this.store.getConversation(conversationId))
			return unknownConversationError(conversationId);
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
			return unknownConversationError(conversationId);
		this.store.setConversationStatus(conversationId, "discarded");
		return { v: PROTOCOL_VERSION, type: "discarded", conversationId };
	}

	private findHarness(harnessId: string): InstalledHarness | undefined {
		return this.harnesses.find(({ definition }) => definition.id === harnessId);
	}

	private summarize(row: ConversationRow): ConversationSummary {
		return conversationSummary(
			row,
			this.store.getTurns(row.id),
			this.scheduler.stateFor(row.id),
		);
	}
}
