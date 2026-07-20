import {
	PROTOCOL_VERSION,
	type DomContext,
	type HarnessEvent,
	type HarnessSelection,
	type LiveTurnSnapshot,
	type PromptElement,
	type ServerMessage,
	type SourceLocation,
	type TurnState,
} from "@pincer/core";

const MAX_LIVE_TEXT_CHARS = 256_000;
const MAX_LIVE_BLOCKS = 200;
const TRUNCATION_MARKER = "\n\n[Live output truncated]";

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
	live: LiveTurnSnapshot;
	cancel: (() => Promise<void>) | null;
	cancelRequested: boolean;
	truncated: boolean;
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
	private readonly queue: ScheduledTurn[] = [];
	private active: ScheduledTurn | null = null;
	private stopping = false;

	constructor(options: {
		publish: (message: ServerMessage) => void;
		execute: TurnExecutor;
		persistQueuedCancellation: (submission: TurnSubmission) => number;
		onStateChanged: () => void;
	}) {
		this.publish = options.publish;
		this.execute = options.execute;
		this.persistQueuedCancellation = options.persistQueuedCancellation;
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
			live: {
				conversationId: submission.conversationId,
				turnId: null,
				seq: null,
				state: "queued",
				queuePosition: this.queue.length + 1,
				prompt: submission.prompt,
				blocks: [],
				selection: { ...submission.selection },
			},
			cancel: null,
			cancelRequested: false,
			truncated: false,
			finished,
			finish,
		};
		this.queue.push(scheduled);
		const snapshot = structuredClone(scheduled.live);
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
				state: this.active.live.state,
				queuePosition: this.active.live.queuePosition,
			};
		}
		const queued = this.queue.find(
			(scheduled) => scheduled.submission.conversationId === conversationId,
		);
		return queued
			? { state: "queued", queuePosition: queued.live.queuePosition }
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
		return scheduled ? structuredClone(scheduled.live) : null;
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
		scheduled.live.queuePosition = null;
		this.refreshQueuePositions();
		this.onStateChanged();

		const controls: TurnExecutionControls = {
			get cancellationRequested() {
				return scheduled.cancelRequested;
			},
			started: (turnId, seq) => {
				scheduled.live.turnId = turnId;
				scheduled.live.seq = seq;
				scheduled.live.state = "running";
				const liveTurn = structuredClone(scheduled.live);
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
			snapshot: () => structuredClone(scheduled.live),
		};

		void this.execute(scheduled.submission, controls)
			.catch((error) => {
				this.publish({
					v: PROTOCOL_VERSION,
					type: "turn_error",
					conversationId: scheduled.submission.conversationId,
					turnId: scheduled.live.turnId,
					message: error instanceof Error ? error.message : String(error),
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
		for (let index = 0; index < this.queue.length; index += 1) {
			const scheduled = this.queue[index];
			if (!scheduled) continue;
			const queuePosition = index + 1;
			if (scheduled.live.queuePosition === queuePosition) continue;
			scheduled.live.queuePosition = queuePosition;
			this.publish({
				v: PROTOCOL_VERSION,
				type: "turn_queued",
				conversationId: scheduled.submission.conversationId,
				liveTurn: structuredClone(scheduled.live),
			});
		}
	}

	private recordEvent(scheduled: ScheduledTurn, event: HarnessEvent): void {
		if (event.kind === "session" || event.kind === "result") return;

		let published = event;
		if (event.kind === "text") {
			if (scheduled.truncated) return;
			const existingText = scheduled.live.blocks.reduce(
				(total, block) => total + (block.t === "md" ? block.text.length : 0),
				0,
			);
			const available = Math.max(0, MAX_LIVE_TEXT_CHARS - existingText);
			const text =
				event.text.length > available
					? event.text.slice(0, available) + TRUNCATION_MARKER
					: event.text;
			if (event.text.length > available) scheduled.truncated = true;
			published = { kind: "text", text };
			const tail = scheduled.live.blocks[scheduled.live.blocks.length - 1];
			if (tail?.t === "md") tail.text += text;
			else scheduled.live.blocks.push({ t: "md", text });
		} else if (event.kind === "tool") {
			if (scheduled.live.blocks.length >= MAX_LIVE_BLOCKS) {
				if (scheduled.truncated) return;
				published = { kind: "text", text: TRUNCATION_MARKER };
				scheduled.live.blocks.push({ t: "md", text: TRUNCATION_MARKER });
				scheduled.truncated = true;
			} else {
				scheduled.live.blocks.push({
					t: "tool",
					name: event.name,
					detail: event.detail,
				});
			}
		} else if (event.kind === "diff") {
			if (scheduled.live.blocks.length >= MAX_LIVE_BLOCKS) {
				if (scheduled.truncated) return;
				published = { kind: "text", text: TRUNCATION_MARKER };
				scheduled.live.blocks.push({ t: "md", text: TRUNCATION_MARKER });
				scheduled.truncated = true;
			} else {
				scheduled.live.blocks.push({
					t: "diff",
					file: event.file,
					hunks: event.hunks,
				});
			}
		}

		if (scheduled.live.turnId === null) return;
		this.publish({
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: scheduled.submission.conversationId,
			turnId: scheduled.live.turnId,
			event: published,
		});
	}
}
