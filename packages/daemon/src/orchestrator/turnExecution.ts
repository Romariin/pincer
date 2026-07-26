import type { GitDiffCollector } from "../diffCollector";
import { HarnessRunner } from "../harnesses/runner/harnessRunner";
import type { InstalledHarness } from "../harnesses/types";
import type { Store } from "../store";
import type { TurnExecutionControls, TurnSubmission } from "../turnScheduler";
import { turnCancelled, turnCompleted, turnFailed } from "./messages";
import { outputFromBlocks } from "./summaries";
import { abortTurnRow, startTurnRow } from "./turnPersistence";
import type { Emit } from "./types";

export interface TurnExecutionDeps {
	store: Store;
	diffCollector: GitDiffCollector;
	findHarness: (harnessId: string) => InstalledHarness | undefined;
	projectRoot: string;
	pincerDataDir: string;
	publish: Emit;
	log: (message: string) => void;
}

export class TurnExecution {
	private readonly runner = new HarnessRunner();

	constructor(private readonly deps: TurnExecutionDeps) {}

	async run(
		submission: TurnSubmission,
		controls: TurnExecutionControls,
	): Promise<void> {
		const { store, publish, log } = this.deps;
		const harness = this.deps.findHarness(submission.selection.harnessId);
		if (!harness?.detected)
			throw new Error(
				`Harness became unavailable: ${submission.selection.harnessId}`,
			);

		const beforeDiffAbort = new AbortController();
		controls.setCancel(async () => beforeDiffAbort.abort());
		const beforeDiff = await this.deps.diffCollector.snapshot(
			beforeDiffAbort.signal,
		);
		const resumeToken = this.resumeTokenFor(submission, harness);

		const { id: turnId, seq } = startTurnRow(store, submission);
		controls.started(turnId, seq);

		const cancel = (): void => {
			abortTurnRow(store, turnId, controls.snapshot().blocks, "cancelled");
			publish(turnCancelled(submission.conversationId, turnId));
		};

		if (controls.cancellationRequested) {
			store.setTurnStatus(turnId, "cancelled");
			publish(turnCancelled(submission.conversationId, turnId));
			return;
		}

		log(
			`turn started harness=${submission.selection.harnessId} model=${submission.selection.model || "default"} effort=${submission.selection.effort || "default"} conversation=${submission.conversationId} turn=${seq}`,
		);
		const running = this.runner.start(
			harness,
			{
				prompt: submission.prompt,
				source: submission.source,
				domContext: submission.domContext,
				elements: submission.elements,
				projectRoot: this.deps.projectRoot,
				pincerDataDir: this.deps.pincerDataDir,
				conversationId: submission.conversationId,
				selection: submission.selection,
				resumeToken,
			},
			controls.event,
		);
		controls.setCancel(running.cancel);
		const outcome = await running.outcome;
		for (const diagnostic of outcome.diagnostics) {
			log(
				`Harness diagnostic conversation=${submission.conversationId} turn=${seq}: ${diagnostic}`,
			);
		}

		if (outcome.status === "cancelled" || controls.cancellationRequested) {
			cancel();
			return;
		}

		if (outcome.status === "failed") {
			abortTurnRow(store, turnId, controls.snapshot().blocks, "error");
			publish(turnFailed(submission.conversationId, turnId, outcome.summary));
			return;
		}

		const afterDiffAbort = new AbortController();
		controls.setCancel(async () => afterDiffAbort.abort());
		for (const diff of await this.deps.diffCollector.collect(
			beforeDiff,
			afterDiffAbort.signal,
		))
			controls.event(diff);
		if (controls.cancellationRequested) {
			cancel();
			return;
		}

		const snapshot = controls.snapshot();
		const output = outputFromBlocks(snapshot.blocks);
		store.updateTurn(turnId, {
			resume_token: outcome.sessionToken,
			checkpoint: null,
			parent_checkpoint: null,
			output,
			blocks: JSON.stringify(snapshot.blocks),
			status: "complete",
		});
		store.touchConversation(submission.conversationId);
		const summary = outcome.summary || output.trim().slice(0, 200) || "done";
		publish(turnCompleted(submission.conversationId, turnId, summary));
		log(`turn complete conversation=${submission.conversationId} turn=${seq}`);
	}

	/**
	 * Resume only across a consecutive run of same-Harness turns: switching
	 * Harness mid-conversation invalidates every earlier session token.
	 */
	private resumeTokenFor(
		submission: TurnSubmission,
		harness: InstalledHarness,
	): string | null {
		if (!harness.definition.capabilities.resume) return null;
		const turns = this.deps.store.getTurns(submission.conversationId);
		for (let index = turns.length - 1; index >= 0; index -= 1) {
			const turn = turns[index];
			if (!turn || turn.harness_id !== submission.selection.harnessId) break;
			if (turn.status !== "complete") continue;
			return turn.resume_token;
		}
		return null;
	}
}
