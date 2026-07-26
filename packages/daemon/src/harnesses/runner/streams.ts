export const MAX_STDERR_CHARS = 16_384;
export const MAX_NDJSON_RECORD_BYTES = 1_048_576;
export const MAX_CATALOG_CHARS = 1_048_576;

export async function readTextTail(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			output = (output + decoder.decode(value, { stream: true })).slice(-limit);
		}
		return (output + decoder.decode()).slice(-limit);
	} finally {
		reader.releaseLock();
	}
}

function joinBytes(parts: readonly Uint8Array[], length: number): Uint8Array {
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}

export async function readLines(
	stream: ReadableStream<Uint8Array>,
	consume: (line: string) => void,
	onOversized: () => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let parts: Uint8Array[] = [];
	let length = 0;
	let oversized = false;

	const append = (part: Uint8Array): void => {
		if (oversized || part.byteLength === 0) return;
		if (length + part.byteLength > MAX_NDJSON_RECORD_BYTES) {
			parts = [];
			length = 0;
			oversized = true;
			return;
		}
		parts.push(part);
		length += part.byteLength;
	};
	const finish = (): void => {
		if (oversized) {
			onOversized();
		} else if (length > 0) {
			const bytes = joinBytes(parts, length);
			const end = bytes[length - 1] === 13 ? length - 1 : length;
			consume(decoder.decode(bytes.subarray(0, end)));
		}
		parts = [];
		length = 0;
		oversized = false;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			let start = 0;
			for (let index = 0; index < value.byteLength; index += 1) {
				if (value[index] !== 10) continue;
				append(value.subarray(start, index));
				finish();
				start = index + 1;
			}
			append(value.subarray(start));
		}
		if (oversized || length > 0) finish();
	} finally {
		reader.releaseLock();
	}
}
