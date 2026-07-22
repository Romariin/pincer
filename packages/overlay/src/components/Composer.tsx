import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import type { PromptElement } from "@pincer/core";
import { selectVisibleTurnState, usePincerStore } from "@/state/store";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function Composer(): ReactNode {
	const view = usePincerStore((state) => state.view);
	const turnState = usePincerStore(selectVisibleTurnState);
	const turnActive = turnState === "queued" || turnState === "running";

	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (view !== "chat") return;
		const t = setTimeout(() => taRef.current?.focus(), 260);
		return () => clearTimeout(t);
	}, [view]);

	const submit = (): void => {
		const state = usePincerStore.getState();
		if (selectVisibleTurnState(state) !== "idle") return;
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
		state.submitPrompt(payload);
		setText("");
		state.clearSelections();
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
					onClick={onSend}
				>
					{turnActive ? "Stop" : "Send"}
				</Button>
			</div>
		</div>
	);
}
