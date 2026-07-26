/**
 * Child output has to pause while the banner animation redraws in place —
 * otherwise a late "compiled successfully" lands between two frames and the
 * cursor-up math scribbles over it. Buffered chunks are flushed on release,
 * and the hold is dropped early if the child turns out to be chatty.
 */
export interface OutputGate {
	write(stream: "stdout" | "stderr", chunk: Uint8Array): void;
	hold(): void;
	release(): void;
}

const GATE_BUFFER_LIMIT = 256 * 1024;

export function createOutputGate(): OutputGate {
	let held = false;
	let buffered = 0;
	const queue: { stream: "stdout" | "stderr"; chunk: Uint8Array }[] = [];
	const passthrough = (
		stream: "stdout" | "stderr",
		chunk: Uint8Array,
	): void => {
		(stream === "stdout" ? process.stdout : process.stderr).write(chunk);
	};
	const gate: OutputGate = {
		write(stream, chunk) {
			if (!held) {
				passthrough(stream, chunk);
				return;
			}
			queue.push({ stream, chunk });
			buffered += chunk.byteLength;
			if (buffered > GATE_BUFFER_LIMIT) gate.release();
		},
		hold() {
			held = true;
		},
		release() {
			held = false;
			buffered = 0;
			for (const item of queue) passthrough(item.stream, item.chunk);
			queue.length = 0;
		},
	};
	return gate;
}
