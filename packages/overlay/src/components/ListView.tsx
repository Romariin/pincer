import type { ReactNode } from "react";
import type { ConversationSummary } from "@pincer/core";
import { usePincerStore } from "@/state/store";
import { harnessInfo, modelLabel } from "@/lib/harness";
import { Avatar } from "./Avatar";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Trash2Icon } from "lucide-react";

const GROUP_ORDER = ["TODAY", "YESTERDAY", "EARLIER"] as const;

function groupLabel(ts: number): (typeof GROUP_ORDER)[number] {
	const now = new Date();
	const d = new Date(ts);
	const same = (a: Date, b: Date): boolean =>
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate();
	if (same(now, d)) return "TODAY";
	const y = new Date(now);
	y.setDate(now.getDate() - 1);
	if (same(y, d)) return "YESTERDAY";
	return "EARLIER";
}

function Row({ c }: { c: ConversationSummary }): ReactNode {
	const harnessMap = usePincerStore((s) => s.harnessMap);
	const openConversation = usePincerStore((state) => state.openConversation);
	const deleteConversation = usePincerStore((state) => state.deleteConversation);
	const optimisticTitle = usePincerStore((state) => {
		const messages = state.threads[c.id]?.messages;
		if (!messages) return "";
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			const first = message?.role === "user" ? message.blocks[0] : undefined;
			if (first?.t === "md") return first.text.trim();
		}
		return "";
	});
	const info = harnessInfo(harnessMap, c.harnessId);
	const title = c.title?.trim() || optimisticTitle || "New conversation";
	const stateLabel =
		c.turnState === "running"
			? "Running"
			: c.turnState === "queued"
				? c.queuePosition === null
					? "Queued"
					: `Queued #${c.queuePosition}`
				: null;

	return (
		<div className="group flex cursor-pointer items-center gap-[11px] rounded-[9px] p-2.5 transition-colors hover:bg-muted">
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-[11px] text-left"
				onClick={() => openConversation(c.id)}
			>
				<Avatar info={info} size={28} />
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground/90">
							{title}
						</span>
						{stateLabel ? (
							<Badge
								variant={c.turnState === "running" ? "default" : "secondary"}
								role="status"
							>
								<span className="size-1.5 rounded-full bg-current opacity-70" />
								{stateLabel}
							</Badge>
						) : null}
					</div>
					<div className="mt-0.5 text-[11.5px] text-muted-foreground">
						{c.turnCount
							? `${info.label} · ${modelLabel(info, c.model)}`
							: "No messages yet"}
					</div>
				</div>
			</button>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Delete conversation"
				className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					deleteConversation(c.id);
				}}
			>
				<Trash2Icon />
			</Button>
		</div>
	);
}

export function ListView(): ReactNode {
	const conversations = usePincerStore((s) => s.conversations);

	if (conversations.length === 0) {
		return (
			<div className="pcr-scroll flex-1 overflow-y-auto px-2 pb-2.5 pt-2">
				<div className="px-[30px] py-[60px] text-center text-[13.5px] leading-[1.6] text-muted-foreground">
					No conversations yet.
					<br />
					Describe a change below to start one.
				</div>
			</div>
		);
	}

	const groups: Record<string, ConversationSummary[]> = {};
	for (const c of conversations) {
		const g = groupLabel(c.updatedAt);
		const group = groups[g] ?? [];
		group.push(c);
		groups[g] = group;
	}

	return (
		<div className="pcr-scroll flex-1 overflow-y-auto px-2 pb-2.5 pt-2">
			{GROUP_ORDER.map((g) => {
				const items = groups[g];
				if (!items || items.length === 0) return null;
				return (
					<div key={g}>
						<div className="flex items-center gap-2.5 px-2 pb-[7px] pt-[15px]">
							<span className="text-[10.5px] font-bold tracking-[0.12em] text-muted-foreground">
								{g}
							</span>
							<span className="h-px flex-1 bg-border" />
						</div>
						{items.map((c) => (
							<Row key={c.id} c={c} />
						))}
					</div>
				);
			})}
		</div>
	);
}
