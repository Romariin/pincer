import type { PromptElement } from "@pincer/core";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { selectVisibleTurnState, usePincerStore } from "@/state/store";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function Composer(): ReactNode {
	const view = usePincerStore((state) => state.view);
	const connected = usePincerStore((state) => state.connected);
	const turnState = usePincerStore(selectVisibleTurnState);
	const creationPending = usePincerStore(
		(state) => state.pendingPrompt !== null,
	);
	const turnActive = turnState === "queued" || turnState === "running";

	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement>(null);
	const awaitingConversation = useRef(false);

	useEffect(() => {
		if (view !== "chat") return;
		const t = setTimeout(() => taRef.current?.focus(), 260);
		return () => clearTimeout(t);
	}, [view]);

	useEffect(() => {
		if (!awaitingConversation.current || creationPending) return;
		if (view === "chat") {
			setText("");
			usePincerStore.getState().clearSelections();
		}
		awaitingConversation.current = false;
	}, [creationPending, view]);

	const submit = (): void => {
		const state = usePincerStore.getState();
		if (
			!state.connected ||
			state.pendingPrompt !== null ||
			selectVisibleTurnState(state) !== "idle"
		)
			return;
		const trimmed = text.trim();
		if (!trimmed) return;
		const elements: PromptElement[] = state.selections.map((selection) => ({
			source: selection.source,
			domContext: selection.domContext,
		}));
		const primary = elements[0] ?? {
			source: null,
			domContext: {
				tag: "page",
				id: null,
				classes: [],
				text: null,
				ancestry: [],
			},
		};
		const payload = {
			prompt: trimmed,
			source: primary.source,
			domContext: primary.domContext,
			elements,
		};
		const creatingConversation = state.view !== "chat" || !state.conversationId;
		state.submitPrompt(payload);
		const next = usePincerStore.getState();
		if (creatingConversation && next.pendingPrompt === payload) {
			awaitingConversation.current = true;
			return;
		}
		if (!creatingConversation && selectVisibleTurnState(next) !== "idle") {
			setText("");
			next.clearSelections();
		}
	};

	const onSend = (): void => {
		const state = usePincerStore.getState();
		if (
			state.view === "chat" &&
			state.conversationId &&
			selectVisibleTurnState(state) !== "idle"
		) {
			state.cancelVisibleTurn();
		} else {
			submit();
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			submit();
		}
	};

	return (
		<div className="shrink-0 px-3 pb-3.5 pt-2">
			<Textarea
				ref={taRef}
				rows={3}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder={
					view === "chat"
						? "Describe the change… (⌘/Ctrl+Enter to send)"
						: "Describe a change to start a new chat…"
				}
			/>
			<div className="mt-2.5 flex gap-2">
				<Button
					className="flex-1"
					size="lg"
					variant={turnActive ? "secondary" : "default"}
					disabled={!connected || creationPending}
					onClick={onSend}
				>
					{creationPending ? "Starting…" : turnActive ? "Stop" : "Send"}
				</Button>
			</div>
		</div>
	);
}
