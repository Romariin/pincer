import type {
	HarnessEvent,
	HarnessSelection,
	LiveTurnSnapshot,
} from "@pincer/core";

const TRUNCATION_MARKER = "\n\n[Live output truncated]";

export class LiveTurnBuffer {
	private readonly live: LiveTurnSnapshot;
	private readonly maxTextChars: number;
	private readonly maxBlocks: number;
	private truncated = false;

	constructor(options: {
		conversationId: string;
		prompt: string;
		selection: HarnessSelection;
		queuePosition?: number;
		maxTextChars?: number;
		maxBlocks?: number;
	}) {
		this.maxTextChars = options.maxTextChars ?? 256_000;
		this.maxBlocks = options.maxBlocks ?? 200;
		this.live = {
			conversationId: options.conversationId,
			turnId: null,
			seq: null,
			state: "queued",
			queuePosition: options.queuePosition ?? 1,
			prompt: options.prompt,
			blocks: [],
			selection: { ...options.selection },
		};
	}

	start(turnId: number, seq: number): void {
		this.live.turnId = turnId;
		this.live.seq = seq;
		this.live.state = "running";
		this.live.queuePosition = null;
	}

	setQueuePosition(position: number | null): void {
		this.live.queuePosition = position;
	}

	snapshot(): LiveTurnSnapshot {
		return structuredClone(this.live);
	}

	record(event: HarnessEvent): HarnessEvent | null {
		if (event.kind === "session" || event.kind === "result") return null;
		if (event.kind === "status") return event;
		if (event.kind === "text") return this.recordText(event.text);
		if (this.live.blocks.length >= this.maxBlocks) {
			if (this.truncated) return null;
			this.live.blocks.push({ t: "md", text: TRUNCATION_MARKER });
			this.truncated = true;
			return { kind: "text", text: TRUNCATION_MARKER };
		}
		if (event.kind === "tool") {
			this.live.blocks.push({
				t: "tool",
				name: event.name,
				detail: event.detail,
			});
		} else {
			this.live.blocks.push({
				t: "diff",
				file: event.file,
				hunks: event.hunks,
			});
		}
		return event;
	}

	private recordText(value: string): HarnessEvent | null {
		if (this.truncated) return null;
		const existing = this.live.blocks.reduce(
			(total, block) => total + (block.t === "md" ? block.text.length : 0),
			0,
		);
		const available = Math.max(0, this.maxTextChars - existing);
		const text =
			value.length > available
				? value.slice(0, available) + TRUNCATION_MARKER
				: value;
		if (value.length > available) this.truncated = true;
		const tail = this.live.blocks[this.live.blocks.length - 1];
		if (tail?.t === "md") tail.text += text;
		else this.live.blocks.push({ t: "md", text });
		return { kind: "text", text };
	}
}
