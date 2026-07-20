import { describe, expect, test } from "bun:test";
import { DEFAULT_TOGGLE_SHORTCUT, PROTOCOL_VERSION } from "@pincer/core";
import type {
	ClientMessage,
	ConversationSummary,
	HarnessDescriptor,
	LiveTurnSnapshot,
	MessageBlock,
	ServerMessage,
	TurnSummary,
} from "@pincer/core";
import {
	selectVisibleTurnState,
	usePincerStore,
	type ConversationThread,
} from "../src/state/store";

function resetStore(): void {
	usePincerStore.setState({
		connected: false,
		view: "list",
		panelOpen: false,
		selecting: false,
		picker: null,
		shortcut: DEFAULT_TOGGLE_SHORTCUT,
		showFloatingButton: true,
		appRoot: null,
		appOrigin: null,
		settingsLoaded: false,
		settingsPending: false,
		settingsError: null,
		recordingShortcut: false,
		harnesses: [],
		harnessMap: {},
		draft: { harnessId: "", model: "", effort: "High" },
		conversations: [],
		conversationId: null,
		threads: {},
		pendingPrompt: null,
		selections: [],
		send: () => {},
	});
}

function conversation(
	id: string,
	turnState: ConversationSummary["turnState"] = "idle",
	queuePosition: number | null = null,
): ConversationSummary {
	return {
		id,
		branch: `pincer/${id}`,
		status: "active",
		createdAt: 1,
		updatedAt: 2,
		turnCount: 0,
		title: `${id} title`,
		harnessId: "codex",
		model: "gpt-5",
		effort: "high",
		turnState,
		queuePosition,
	};
}

function liveTurn(
	conversationId: string,
	overrides: Partial<LiveTurnSnapshot> = {},
): LiveTurnSnapshot {
	return {
		conversationId,
		turnId: 1,
		seq: 0,
		state: "running",
		queuePosition: null,
		prompt: `${conversationId} prompt`,
		blocks: [],
		selection: { harnessId: "codex", model: "gpt-5", effort: "high" },
		...overrides,
	};
}

function turn(
	seq: number,
	prompt: string,
	blocks: MessageBlock[],
): TurnSummary {
	return {
		id: seq + 1,
		seq,
		prompt,
		checkpoint: `checkpoint-${seq}`,
		status: "complete",
		createdAt: seq + 1,
		output: blocks
			.filter(
				(block): block is Extract<MessageBlock, { t: "md" }> =>
					block.t === "md",
			)
			.map((block) => block.text)
			.join(""),
		blocks,
	};
}

function harness(
	id: string,
	overrides: Partial<HarnessDescriptor> = {},
): HarnessDescriptor {
	return {
		id,
		label: id,
		glyph: ">_",
		c1: "#111111",
		c2: "#222222",
		detected: true,
		models: [{ id: "gpt-5", label: "GPT-5", efforts: ["low", "high"] }],
		...overrides,
	};
}

const welcome = (harnesses: HarnessDescriptor[] = []): ServerMessage => ({
	v: PROTOCOL_VERSION,
	type: "welcome",
	daemonVersion: "test",
	protocolVersion: PROTOCOL_VERSION,
	projectRoot: "/project",
	harnesses,
	defaultHarnessId: harnesses[0]?.id ?? null,
});

const apply = (message: ServerMessage): void =>
	usePincerStore.getState().applyServerMessage(message);

function resume(
	summary: ConversationSummary,
	turns: TurnSummary[] = [],
	current: LiveTurnSnapshot | null = null,
): void {
	apply({
		v: PROTOCOL_VERSION,
		type: "conversation_resumed",
		conversation: summary,
		turns,
		liveTurn: current,
	});
}

function requireThread(conversationId: string): ConversationThread {
	const thread = usePincerStore.getState().threads[conversationId];
	if (!thread) throw new Error(`expected thread ${conversationId}`);
	return thread;
}

function content(conversationId: string): Array<{
	role: "user" | "assistant" | "system";
	blocks: MessageBlock[];
}> {
	return requireThread(conversationId).messages.map(({ role, blocks }) => ({
		role,
		blocks,
	}));
}

function setupHiddenAndVisible(
	hiddenLive: LiveTurnSnapshot,
	hiddenState: ConversationSummary["turnState"],
): void {
	apply({
		v: PROTOCOL_VERSION,
		type: "conversations",
		items: [
			conversation("visible", "running"),
			conversation("hidden", hiddenState),
		],
	});
	resume(
		conversation("hidden", hiddenState, hiddenLive.queuePosition),
		[],
		hiddenLive,
	);
	resume(
		conversation("visible", "running"),
		[],
		liveTurn("visible", {
			turnId: 11,
			seq: 3,
			prompt: "visible prompt",
			blocks: [{ t: "md", text: "visible output" }],
		}),
	);
}

describe("per-conversation protocol routing", () => {
	test("hidden text, tool output, and completion update only the owning thread", () => {
		resetStore();
		setupHiddenAndVisible(
			liveTurn("hidden", { turnId: 22, seq: 5, prompt: "hidden prompt" }),
			"running",
		);
		const visibleBefore = structuredClone(requireThread("visible"));

		apply({
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: "hidden",
			turnId: 22,
			event: { kind: "text", text: "hidden answer" },
		});
		apply({
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: "hidden",
			turnId: 22,
			event: { kind: "tool", name: "Read", detail: "hidden.ts" },
		});

		expect(content("hidden")).toEqual([
			{ role: "user", blocks: [{ t: "md", text: "hidden prompt" }] },
			{
				role: "assistant",
				blocks: [
					{ t: "md", text: "hidden answer" },
					{ t: "tool", name: "Read", detail: "hidden.ts" },
				],
			},
		]);
		expect(requireThread("visible")).toEqual(visibleBefore);
		expect(selectVisibleTurnState(usePincerStore.getState())).toBe("running");

		apply({
			v: PROTOCOL_VERSION,
			type: "turn_complete",
			conversationId: "hidden",
			turnId: 22,
			checkpoint: "hidden-checkpoint",
			success: true,
			summary: "done",
		});

		const completedContent = content("hidden");
		expect(requireThread("hidden").turnState).toBe("idle");
		apply({
			v: PROTOCOL_VERSION,
			type: "harness_output",
			conversationId: "hidden",
			turnId: 22,
			event: { kind: "text", text: "late output" },
		});
		expect(content("hidden")).toEqual(completedContent);
		expect(requireThread("visible")).toEqual(visibleBefore);
		expect(selectVisibleTurnState(usePincerStore.getState())).toBe("running");
	});

	test("a queued hidden error with a nullable turn id annotates only its owner", () => {
		resetStore();
		setupHiddenAndVisible(
			liveTurn("hidden", {
				turnId: null,
				seq: null,
				state: "queued",
				queuePosition: 2,
				prompt: "queued hidden prompt",
			}),
			"queued",
		);
		const visibleBefore = structuredClone(requireThread("visible"));

		apply({
			v: PROTOCOL_VERSION,
			type: "turn_error",
			conversationId: "hidden",
			turnId: null,
			message: "hidden failure",
		});

		expect(content("hidden")).toEqual([
			{ role: "user", blocks: [{ t: "md", text: "queued hidden prompt" }] },
			{ role: "system", blocks: [{ t: "md", text: "Error: hidden failure" }] },
		]);
		expect(requireThread("hidden").turnState).toBe("idle");
		expect(requireThread("visible")).toEqual(visibleBefore);
		expect(selectVisibleTurnState(usePincerStore.getState())).toBe("running");
	});

	test("cancelling a queued hidden turn with no turn id leaves the visible run untouched", () => {
		resetStore();
		setupHiddenAndVisible(
			liveTurn("hidden", {
				turnId: null,
				seq: null,
				state: "queued",
				queuePosition: 4,
				prompt: "cancel hidden prompt",
			}),
			"queued",
		);
		const visibleBefore = structuredClone(requireThread("visible"));

		apply({
			v: PROTOCOL_VERSION,
			type: "turn_cancelled",
			conversationId: "hidden",
			turnId: null,
		});

		expect(content("hidden")).toEqual([
			{ role: "user", blocks: [{ t: "md", text: "cancel hidden prompt" }] },
		]);
		expect(requireThread("hidden").turnState).toBe("idle");
		expect(requireThread("visible")).toEqual(visibleBefore);
		expect(selectVisibleTurnState(usePincerStore.getState())).toBe("running");
	});
});

test("queued and started snapshots record one prompt and transition the owner through FIFO state", () => {
	resetStore();
	apply({
		v: PROTOCOL_VERSION,
		type: "conversations",
		items: [conversation("owner"), conversation("unrelated")],
	});
	resume(conversation("owner"));

	apply({
		v: PROTOCOL_VERSION,
		type: "turn_queued",
		conversationId: "owner",
		liveTurn: liveTurn("owner", {
			turnId: null,
			seq: null,
			state: "queued",
			queuePosition: 3,
			prompt: "queued once",
		}),
	});

	expect(content("owner")).toEqual([
		{ role: "user", blocks: [{ t: "md", text: "queued once" }] },
	]);
	expect(requireThread("owner")).toMatchObject({
		turnState: "queued",
		queuePosition: 3,
	});
	expect(
		usePincerStore.getState().conversations.find(({ id }) => id === "owner"),
	).toMatchObject({
		turnState: "queued",
		queuePosition: 3,
	});

	apply({
		v: PROTOCOL_VERSION,
		type: "turn_started",
		conversationId: "owner",
		turnId: 41,
		seq: 7,
		liveTurn: liveTurn("owner", {
			turnId: 41,
			seq: 7,
			state: "running",
			queuePosition: null,
			prompt: "queued once",
			blocks: [{ t: "md", text: "already live" }],
		}),
	});

	expect(content("owner")).toEqual([
		{ role: "user", blocks: [{ t: "md", text: "queued once" }] },
		{ role: "assistant", blocks: [{ t: "md", text: "already live" }] },
	]);
	expect(requireThread("owner")).toMatchObject({
		turnState: "running",
		queuePosition: null,
	});
	expect(
		usePincerStore.getState().conversations.find(({ id }) => id === "owner"),
	).toMatchObject({
		turnState: "running",
		queuePosition: null,
	});
});

test("resume reconstructs persisted plus live blocks once and reconnect/list preserve every thread", () => {
	resetStore();
	resume(conversation("unrelated"), [
		turn(0, "unrelated prompt", [{ t: "md", text: "unrelated answer" }]),
	]);
	const unrelatedBefore = structuredClone(requireThread("unrelated"));

	resume(
		conversation("owner", "running"),
		[
			turn(0, "persisted prompt", [{ t: "md", text: "persisted answer" }]),
			turn(1, "live prompt", [
				{ t: "md", text: "stale persisted live output" },
			]),
		],
		liveTurn("owner", {
			turnId: 70,
			seq: 1,
			state: "running",
			prompt: "live prompt",
			blocks: [
				{ t: "md", text: "current live output" },
				{ t: "tool", name: "Edit", detail: "owner.ts" },
			],
		}),
	);

	expect(content("owner")).toEqual([
		{ role: "user", blocks: [{ t: "md", text: "persisted prompt" }] },
		{ role: "assistant", blocks: [{ t: "md", text: "persisted answer" }] },
		{ role: "user", blocks: [{ t: "md", text: "live prompt" }] },
		{
			role: "assistant",
			blocks: [
				{ t: "md", text: "current live output" },
				{ t: "tool", name: "Edit", detail: "owner.ts" },
			],
		},
	]);
	expect(requireThread("unrelated")).toEqual(unrelatedBefore);

	const ownerBeforeReconnect = structuredClone(requireThread("owner"));
	apply(welcome([harness("codex")]));
	apply({
		v: PROTOCOL_VERSION,
		type: "conversations",
		items: [conversation("owner", "running"), conversation("unrelated")],
	});

	expect(requireThread("owner")).toEqual(ownerBeforeReconnect);
	expect(requireThread("unrelated")).toEqual(unrelatedBefore);
});

test("submission is exclusive per conversation rather than global", () => {
	resetStore();
	const sent: ClientMessage[] = [];
	usePincerStore.getState().setSend((message) => sent.push(message));
	resume(conversation("other"));
	resume(conversation("visible"));

	const submit = (conversationId: string, prompt: string): void => {
		const before = requireThread(conversationId).messages.length;
		usePincerStore.getState().queueUserMessage(conversationId, prompt, 0);
		if (requireThread(conversationId).messages.length === before) return;
		usePincerStore.getState().send({
			v: PROTOCOL_VERSION,
			type: "prompt",
			conversationId,
			prompt,
			source: null,
			domContext: {
				tag: "div",
				id: null,
				classes: [],
				text: null,
				ancestry: [],
			},
			elements: [],
		});
	};

	submit("visible", "first visible prompt");
	submit("visible", "duplicate visible prompt");
	submit("other", "independent prompt");

	expect(content("visible")).toEqual([
		{ role: "user", blocks: [{ t: "md", text: "first visible prompt" }] },
	]);
	expect(content("other")).toEqual([
		{ role: "user", blocks: [{ t: "md", text: "independent prompt" }] },
	]);
	expect(
		sent.map((message) =>
			"conversationId" in message ? message.conversationId : null,
		),
	).toEqual(["visible", "other"]);
});

test("cancel requests are sent only for the visible queued or running conversation", () => {
	resetStore();
	const sent: ClientMessage[] = [];
	usePincerStore.getState().setSend((message) => sent.push(message));
	resume(
		conversation("hidden", "running"),
		[],
		liveTurn("hidden", { turnId: 20, seq: 2, state: "running" }),
	);
	resume(
		conversation("visible", "queued", 1),
		[],
		liveTurn("visible", {
			turnId: null,
			seq: null,
			state: "queued",
			queuePosition: 1,
		}),
	);

	const cancelVisible = (): void => {
		const state = usePincerStore.getState();
		if (
			state.view === "chat" &&
			state.conversationId &&
			selectVisibleTurnState(state) !== "idle"
		) {
			state.send({
				v: PROTOCOL_VERSION,
				type: "cancel",
				conversationId: state.conversationId,
			});
		}
	};

	cancelVisible();
	expect(sent).toEqual([
		{ v: PROTOCOL_VERSION, type: "cancel", conversationId: "visible" },
	]);

	apply({
		v: PROTOCOL_VERSION,
		type: "turn_cancelled",
		conversationId: "visible",
		turnId: null,
	});
	cancelVisible();
	resume(
		conversation("visible", "running"),
		[],
		liveTurn("visible", { turnId: 30, seq: 8, state: "running" }),
	);
	cancelVisible();
	usePincerStore.getState().setView("list");
	cancelVisible();

	expect(sent.filter((message) => message.type === "cancel")).toEqual([
		{ v: PROTOCOL_VERSION, type: "cancel", conversationId: "visible" },
		{ v: PROTOCOL_VERSION, type: "cancel", conversationId: "visible" },
	]);
	expect(requireThread("hidden").turnState).toBe("running");
});

test("welcome initializes a new draft from the first catalog model with no effort", () => {
	resetStore();
	const selectable = harness("selectable", {
		models: [
			{ id: "catalog-first", label: "Catalog first", efforts: ["low"] },
			{ id: "catalog-second", label: "Catalog second", efforts: ["high"] },
		],
	});

	apply(welcome([selectable]));

	expect(usePincerStore.getState().draft).toEqual({
		harnessId: "selectable",
		model: "catalog-first",
		effort: "",
	});
});

test("welcome repairs a legacy empty model from the catalog without inventing an effort", () => {
	resetStore();
	const selectable = harness("selectable", {
		models: [
			{ id: "catalog-first", label: "Catalog first", efforts: ["low"] },
			{ id: "catalog-second", label: "Catalog second", efforts: ["high"] },
		],
	});
	usePincerStore.getState().updateCfg({
		harnessId: "selectable",
		model: "",
		effort: "legacy-default",
	});

	apply(welcome([selectable]));

	expect(usePincerStore.getState().draft).toEqual({
		harnessId: "selectable",
		model: "catalog-first",
		effort: "",
	});
});

test("welcome retains a nonempty opaque persisted model without supplying an effort", () => {
	resetStore();
	const selectable = harness("selectable", {
		models: [
			{ id: "catalog-first", label: "Catalog first", efforts: ["low"] },
			{ id: "catalog-second", label: "Catalog second", efforts: ["high"] },
		],
	});
	usePincerStore.getState().updateCfg({
		harnessId: "selectable",
		model: "future-model",
		effort: "",
	});

	apply(welcome([selectable]));

	expect(usePincerStore.getState().draft).toEqual({
		harnessId: "selectable",
		model: "future-model",
		effort: "",
	});
});

test("model switches enforce catalog efforts while retaining opaque selections", () => {
	resetStore();
	const selectable = harness("selectable", {
		models: [
			{
				id: "supported-model",
				label: "Supported model",
				efforts: ["low", "high"],
			},
			{
				id: "excluding-model",
				label: "Excluding model",
				efforts: ["low"],
			},
			{ id: "no-effort-model", label: "No effort model", efforts: [] },
		],
	});
	apply(welcome([selectable]));

	const state = usePincerStore.getState();
	state.choose("effort", "high");
	state.choose("model", "excluding-model");
	expect(usePincerStore.getState().draft).toMatchObject({
		model: "excluding-model",
		effort: "",
	});

	state.choose("effort", "low");
	state.choose("model", "supported-model");
	expect(usePincerStore.getState().draft).toMatchObject({
		model: "supported-model",
		effort: "low",
	});

	state.choose("effort", "quantum");
	state.choose("model", "no-effort-model");
	expect(usePincerStore.getState().draft).toMatchObject({
		model: "no-effort-model",
		effort: "",
	});

	state.choose("effort", "quantum");
	state.choose("model", "future-model");
	expect(usePincerStore.getState().draft).toMatchObject({
		model: "future-model",
		effort: "quantum",
	});
});

test("an explicit null default Harness never falls back to another detected Harness", () => {
	resetStore();
	const detected = harness("detected");

	apply({
		v: PROTOCOL_VERSION,
		type: "welcome",
		daemonVersion: "test",
		protocolVersion: PROTOCOL_VERSION,
		projectRoot: "/project",
		harnesses: [detected],
		defaultHarnessId: null,
	});

	expect(usePincerStore.getState().draft.harnessId).toBe("");
});

test("switching Harness selects its first catalog model and clears effort", () => {
	resetStore();
	const source = harness("source");
	const destination = harness("destination", {
		models: [
			{ id: "destination-first", label: "Destination first", efforts: ["low"] },
			{
				id: "destination-second",
				label: "Destination second",
				efforts: ["high"],
			},
		],
	});
	usePincerStore.getState().updateCfg({
		harnessId: "source",
		model: "stale-model",
		effort: "stale-effort",
	});
	apply(welcome([source, destination]));

	usePincerStore.getState().choose("harness", "destination");

	expect(usePincerStore.getState().draft).toEqual({
		harnessId: "destination",
		model: "destination-first",
		effort: "",
	});
});

describe("overlay settings acknowledgements", () => {
	test("settings changes apply only after the daemon acknowledgement", () => {
		resetStore();
		const sent: ClientMessage[] = [];
		const acknowledgedShortcut = {
			code: "KeyJ",
			alt: true,
			ctrl: false,
			shift: false,
			meta: false,
		};
		usePincerStore.setState({
			connected: true,
			send: (message) => sent.push(message),
		});
		usePincerStore
			.getState()
			.prepareSettings("/app", "http://localhost:5173", null);
		apply({
			v: PROTOCOL_VERSION,
			type: "overlay_settings",
			settings: {
				appRoot: "/app",
				appOrigin: "http://localhost:5173",
				shortcut: acknowledgedShortcut,
				showFloatingButton: true,
			},
		});
		const updatedShortcut = {
			code: "KeyK",
			alt: false,
			ctrl: true,
			shift: true,
			meta: false,
		};

		usePincerStore.getState().updateShortcut(updatedShortcut);

		expect(usePincerStore.getState().shortcut).toEqual(acknowledgedShortcut);
		expect(usePincerStore.getState().settingsPending).toBe(true);
		expect(sent).toEqual([
			{
				v: PROTOCOL_VERSION,
				type: "update_overlay_settings",
				appRoot: "/app",
				appOrigin: "http://localhost:5173",
				shortcut: updatedShortcut,
			},
		]);

		apply({
			v: PROTOCOL_VERSION,
			type: "overlay_settings",
			settings: {
				appRoot: "/canonical/app",
				appOrigin: "http://localhost:5173",
				shortcut: updatedShortcut,
				showFloatingButton: true,
			},
		});
		expect(usePincerStore.getState().shortcut).toEqual(updatedShortcut);
		expect(usePincerStore.getState().appRoot).toBe("/canonical/app");
		expect(usePincerStore.getState().settingsPending).toBe(false);
	});

	test("settings acknowledgements from a stale origin are ignored", () => {
		resetStore();
		const retainedShortcut = {
			code: "KeyJ",
			alt: true,
			ctrl: false,
			shift: false,
			meta: false,
		};
		usePincerStore.setState({
			appRoot: "/app",
			appOrigin: "http://localhost:5173",
			settingsLoaded: true,
			shortcut: retainedShortcut,
			showFloatingButton: false,
		});

		apply({
			v: PROTOCOL_VERSION,
			type: "overlay_settings",
			settings: {
				appRoot: "/app",
				appOrigin: "http://localhost:5174",
				shortcut: {
					code: "KeyK",
					alt: false,
					ctrl: true,
					shift: true,
					meta: false,
				},
				showFloatingButton: true,
			},
		});

		expect(usePincerStore.getState().shortcut).toEqual(retainedShortcut);
		expect(usePincerStore.getState().showFloatingButton).toBe(false);
		expect(usePincerStore.getState().appOrigin).toBe("http://localhost:5173");
	});

	test("opening settings atomically clears transient conversation interactions", () => {
		resetStore();
		usePincerStore.setState({
			view: "chat",
			picker: "harness",
			selecting: true,
			recordingShortcut: true,
		});

		usePincerStore.getState().openSettings();

		expect(usePincerStore.getState()).toMatchObject({
			view: "settings",
			picker: null,
			selecting: false,
			recordingShortcut: false,
		});
	});

	test("settings failures preserve acknowledged values and expose the error", () => {
		resetStore();
		const shortcut = {
			code: "KeyK",
			alt: false,
			ctrl: true,
			shift: true,
			meta: false,
		};
		usePincerStore.setState({ connected: true, send: () => {} });
		usePincerStore
			.getState()
			.prepareSettings("/app", "http://localhost:5173", null);
		apply({
			v: PROTOCOL_VERSION,
			type: "overlay_settings",
			settings: {
				appRoot: "/app",
				appOrigin: "http://localhost:5173",
				shortcut,
				showFloatingButton: false,
			},
		});
		usePincerStore.getState().updateShowFloatingButton(true);

		apply({
			v: PROTOCOL_VERSION,
			type: "error",
			code: "settings_unavailable",
			message: "Pincer settings are unavailable.",
		});

		expect(usePincerStore.getState()).toMatchObject({
			shortcut,
			showFloatingButton: false,
			settingsPending: false,
			settingsError: "Pincer settings are unavailable.",
		});
	});
});
