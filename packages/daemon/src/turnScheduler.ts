import {
	type DomContext,
	type HarnessEvent,
	type HarnessSelection,
	type LiveTurnSnapshot,
	PROTOCOL_VERSION,
	type PromptElement,
	type ServerMessage,
	type SourceLocation,
	type TurnState,
} from "@pincer/core";
import { LiveTurnBuffer } from "./liveTurnBuffer";

export interface TurnSubmission {
	conversationId: string;
	prompt: string;
	source: SourceLocation | null;
	domContext: DomContext;
	elements: PromptElement[];
	selection: HarnessSelection;
}

export interface TurnExecutionControls {
	readonly cancellationRequested: boolean;
	started(turnId: number, seq: number): void;
	setCancel(cancel: () => Promise<void>): void;
	event(event: HarnessEvent): void;
	snapshot(): LiveTurnSnapshot;
}

export type TurnExecutor = (
	submission: TurnSubmission,
	controls: TurnExecutionControls,
) => Promise<void>;

interface ScheduledTurn {
	submission: TurnSubmission;
	buffer: LiveTurnBuffer;
	cancel: (() => Promise<void>) | null;
	cancelRequested: boolean;
	finished: Promise<void>;
	finish(): void;
}

/** Owns one direct-edit execution slot and a submission-order queue independently of browser lifetime. */
export class TurnScheduler {
	private readonly publish: (message: ServerMessage) => void;
	private readonly execute: TurnExecutor;
	private readonly onStateChanged: () => void;
	private readonly persistQueuedCancellation: (
		submission: TurnSubmission,
	) => number;
	private readonly persistUnexpectedError: (
		submission: TurnSubmission,
		snapshot: LiveTurnSnapshot,
		message: string,
	) => { turnId: number; seq: number };
	private readonly queue: ScheduledTurn[] = [];
	private active: ScheduledTurn | null = null;
	private stopping = false;

	constructor(options: {
		publish: (message: ServerMessage) => void;
		execute: TurnExecutor;
		persistQueuedCancellation: (submission: TurnSubmission) => number;
		persistUnexpectedError: (
			submission: TurnSubmission,
			snapshot: LiveTurnSnapshot,
			message: string,
		) => { turnId: number; seq: number };
		onStateChanged: () => void;
	}) {
		this.publish = options.publish;
		this.execute = options.execute;
		this.persistQueuedCancellation = options.persistQueuedCancellation;
		this.persistUnexpectedError = options.persistUnexpectedError;
		this.onStateChanged = options.onStateChanged;
	}

	submit(submission: TurnSubmission): LiveTurnSnapshot | null {
		if (this.stopping || this.hasOutstanding(submission.conversationId))
			return null;

		let finish = (): void => {};
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const scheduled: ScheduledTurn = {
			submission,
			buffer: new LiveTurnBuffer({
				conversationId: submission.conversationId,
				prompt: submission.prompt,
				selection: submission.selection,
				queuePosition:
					this.queue.length +
					(this.active?.buffer.snapshot().state === "queued" ? 2 : 1),
			}),
			cancel: null,
			cancelRequested: false,
			finished,
			finish,
		};
		this.queue.push(scheduled);
		const snapshot = scheduled.buffer.snapshot();
		this.publish({
			v: PROTOCOL_VERSION,
			type: "turn_queued",
			conversationId: submission.conversationId,
			liveTurn: snapshot,
		});
		this.onStateChanged();
		queueMicrotask(() => this.startNext());
		return snapshot;
	}

	hasOutstanding(conversationId: string): boolean {
		return (
			this.active?.submission.conversationId === conversationId ||
			this.queue.some(
				(scheduled) => scheduled.submission.conversationId === conversationId,
			)
		);
	}

	stateFor(conversationId: string): {
		state: TurnState;
		queuePosition: number | null;
	} {
		if (this.active?.submission.conversationId === conversationId) {
			return {
				state: this.active.buffer.snapshot().state,
				queuePosition: this.active.buffer.snapshot().queuePosition,
			};
		}
		const queued = this.queue.find(
			(scheduled) => scheduled.submission.conversationId === conversationId,
		);
		return queued
			? {
					state: "queued",
					queuePosition: queued.buffer.snapshot().queuePosition,
				}
			: { state: "idle", queuePosition: null };
	}

	snapshot(conversationId: string): LiveTurnSnapshot | null {
		const scheduled =
			this.active?.submission.conversationId === conversationId
				? this.active
				: this.queue.find(
						(candidate) =>
							candidate.submission.conversationId === conversationId,
					);
		return scheduled ? scheduled.buffer.snapshot() : null;
	}

	async cancel(conversationId: string): Promise<boolean> {
		const queuedIndex = this.queue.findIndex(
			(scheduled) => scheduled.submission.conversationId === conversationId,
		);
		if (queuedIndex >= 0) {
			const [scheduled] = this.queue.splice(queuedIndex, 1);
			if (!scheduled) return false;
			scheduled.cancelRequested = true;
			const turnId = this.persistQueuedCancellation(scheduled.submission);
			this.publish({
				v: PROTOCOL_VERSION,
				type: "turn_cancelled",
				conversationId,
				turnId,
			});
			scheduled.finish();
			this.refreshQueuePositions();
			this.onStateChanged();
			return true;
		}

		if (this.active?.submission.conversationId !== conversationId) return false;
		const active = this.active;
		active.cancelRequested = true;
		if (active.cancel) await active.cancel();
		await active.finished;
		return true;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		for (const scheduled of this.queue.splice(0)) {
			scheduled.cancelRequested = true;
			const turnId = this.persistQueuedCancellation(scheduled.submission);
			this.publish({
				v: PROTOCOL_VERSION,
				type: "turn_cancelled",
				conversationId: scheduled.submission.conversationId,
				turnId,
			});
			scheduled.finish();
		}
		const active = this.active;
		if (active) {
			active.cancelRequested = true;
			if (active.cancel) await active.cancel();
			await active.finished;
		}
		this.onStateChanged();
	}

	private startNext(): void {
		if (this.stopping || this.active || this.queue.length === 0) return;
		const scheduled = this.queue.shift();
		if (!scheduled) return;
		this.active = scheduled;
		this.refreshQueuePositions();
		this.onStateChanged();

		const controls: TurnExecutionControls = {
			get cancellationRequested() {
				return scheduled.cancelRequested;
			},
			started: (turnId, seq) => {
				scheduled.buffer.start(turnId, seq);
				this.refreshQueuePositions();
				const liveTurn = scheduled.buffer.snapshot();
				this.publish({
					v: PROTOCOL_VERSION,
					type: "turn_started",
					conversationId: scheduled.submission.conversationId,
					turnId,
					seq,
					liveTurn,
				});
				this.onStateChanged();
			},
			setCancel: (cancel) => {
				scheduled.cancel = cancel;
				if (scheduled.cancelRequested) void cancel();
			},
			event: (event) => this.recordEvent(scheduled, event),
			snapshot: () => scheduled.buffer.snapshot(),
		};

		void this.execute(scheduled.submission, controls)
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				const persisted = this.persistUnexpectedError(
					scheduled.submission,
					scheduled.buffer.snapshot(),
					message,
				);
				if (scheduled.buffer.snapshot().turnId === null)
					controls.started(persisted.turnId, persisted.seq);
				this.publish({
					v: PROTOCOL_VERSION,
					type: "turn_error",
					conversationId: scheduled.submission.conversationId,
					turnId: persisted.turnId,
					message,
				});
			})
			.finally(() => {
				if (this.active === scheduled) this.active = null;
				scheduled.finish();
				this.onStateChanged();
				this.startNext();
			});
	}

	private refreshQueuePositions(): void {
		const offset = this.active?.buffer.snapshot().state === "queued" ? 1 : 0;
		for (let index = 0; index < this.queue.length; index += 1) {
			const scheduled = this.queue[index];
			if (!scheduled) continue;
			const queuePosition = index + offset + 1;
			if (scheduled.buffer.snapshot().queuePosition === queuePosition) continue;
			scheduled.buffer.setQueuePosition(queuePosition);
			this.publish({
				v: PROTOCOL_VERSION,
				type: "turn_queued",
				conversationId: scheduled.submission.conversationId,
				liveTurn: scheduled.buffer.snapshot(),
			});
		}
	}

	private recordEvent(scheduled: ScheduledTurn, event: HarnessEvent): void {
		const published = scheduled.buffer.record(event);
		const snapshot = scheduled.buffer.snapshot();
		if (!published || snapshot.turnId === null) return;
		this.publish({
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: scheduled.submission.conversationId,
			turnId: snapshot.turnId,
			event: published,
		});
	}
}
