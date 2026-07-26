import {
	type ClientMessage,
	MAX_CLIENT_FRAME_BYTES,
	parseClientMessage,
} from "@pincer/core";

export type ClientFrame =
	| { kind: "message"; message: ClientMessage }
	| { kind: "rejected"; reason: string }
	| { kind: "unsupported_version" };

export function readClientFrame(raw: string | Buffer): ClientFrame {
	const frameBytes =
		typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
	if (frameBytes > MAX_CLIENT_FRAME_BYTES)
		return { kind: "rejected", reason: "Message is too large." };

	let parsed: unknown;
	try {
		parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
	} catch {
		return { kind: "rejected", reason: "Invalid JSON." };
	}

	const result = parseClientMessage(parsed);
	if (result.ok) return { kind: "message", message: result.value };
	if (result.error === "Unsupported protocol version.")
		return { kind: "unsupported_version" };
	return { kind: "rejected", reason: result.error };
}
