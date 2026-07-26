import type { MessageBlock } from "@pincer/core";
import {
	FilePlusIcon,
	FileTextIcon,
	FolderSearchIcon,
	GlobeIcon,
	ListTodoIcon,
	LoaderCircleIcon,
	PencilIcon,
	SearchIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useOverlayContainer } from "@/context/overlay";
import { effortLabel, harnessInfo, modelLabel } from "@/lib/harness";
import type { Msg } from "@/state/store";
import { usePincerStore } from "@/state/store";
import { Avatar } from "./Avatar";
import { Diff } from "./blocks/Diff";
import { Markdown } from "./blocks/Markdown";
import { Badge } from "./ui/badge";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "./ui/marker";
import {
	MessageAvatar,
	MessageContent,
	Message as MessageRoot,
} from "./ui/message";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Pick a glyph that reflects what the tool did (read/edit/run/…), matching the harness's own vocabulary. */
function toolIcon(name: string): ReactNode {
	const n = name.toLowerCase();
	if (n.includes("read") || n.includes("view") || n.includes("cat"))
		return <FileTextIcon />;
	if (
		n.includes("edit") ||
		n.includes("patch") ||
		n.includes("apply") ||
		n.includes("update")
	)
		return <PencilIcon />;
	if (n.includes("write") || n.includes("create")) return <FilePlusIcon />;
	if (
		n.includes("bash") ||
		n.includes("shell") ||
		n.includes("exec") ||
		n.includes("command") ||
		n.includes("run") ||
		n.includes("terminal")
	)
		return <TerminalIcon />;
	if (n.includes("grep") || n.includes("search")) return <SearchIcon />;
	if (
		n.includes("glob") ||
		n.includes("find") ||
		n.includes("list") ||
		n === "ls"
	)
		return <FolderSearchIcon />;
	if (
		n.includes("fetch") ||
		n.includes("web") ||
		n.includes("http") ||
		n.includes("url")
	)
		return <GlobeIcon />;
	if (n.includes("todo")) return <ListTodoIcon />;
	return <WrenchIcon />;
}

function renderBlock(block: MessageBlock, i: number): ReactNode {
	if (block.t === "md")
		return (
			<Bubble key={i} variant="ghost">
				<BubbleContent className="leading-[1.6] text-foreground/85">
					<Markdown text={block.text} />
				</BubbleContent>
			</Bubble>
		);
	if (block.t === "tool")
		return (
			<Marker key={i}>
				<MarkerIcon>{toolIcon(block.name)}</MarkerIcon>
				<MarkerContent>
					<span className="text-foreground">{block.name}</span>
					{block.detail ? (
						<span className="ml-1.5 font-mono text-primary">
							{block.detail}
						</span>
					) : null}
				</MarkerContent>
			</Marker>
		);
	return <Diff key={i} file={block.file} hunks={block.hunks} />;
}

function ThinkingMarker(): ReactNode {
	return (
		<Marker role="status">
			<MarkerIcon>
				<LoaderCircleIcon className="animate-spin" />
			</MarkerIcon>
			<MarkerContent>Thinking…</MarkerContent>
		</Marker>
	);
}

export function Message({
	msg,
	streaming = false,
}: {
	msg: Msg;
	streaming?: boolean;
}): ReactNode {
	const harnessMap = usePincerStore((s) => s.harnessMap);
	const overlayContainer = useOverlayContainer();

	if (msg.role === "system") {
		const first = msg.blocks[0];
		const text = first?.t === "md" ? first.text : "";
		return (
			<Marker variant="separator">
				<MarkerContent>{text}</MarkerContent>
			</Marker>
		);
	}

	if (msg.role === "user") {
		const text = msg.blocks[0]?.t === "md" ? msg.blocks[0].text : "";
		const count = msg.elementCount ?? 0;
		return (
			<MessageRoot align="end">
				<MessageContent>
					{count > 0 && (
						<Badge variant="secondary">
							{count} element{count === 1 ? "" : "s"}
						</Badge>
					)}
					<Bubble variant="muted">
						<BubbleContent className="text-[13.5px] leading-[1.5]">
							<Markdown text={text} />
						</BubbleContent>
					</Bubble>
				</MessageContent>
			</MessageRoot>
		);
	}

	// assistant
	const meta = msg.meta;
	const info = harnessInfo(harnessMap, meta?.harnessId ?? "");
	return (
		<MessageRoot align="start">
			<MessageAvatar className="self-start bg-transparent">
				{meta ? (
					<Tooltip>
						<TooltipTrigger
							render={<span className="inline-flex cursor-default" />}
						>
							<Avatar info={info} size={28} />
						</TooltipTrigger>
						<TooltipContent
							container={overlayContainer ?? undefined}
							side="bottom"
							align="start"
						>
							{info.label}
							{meta.model ? ` · model ${modelLabel(info, meta.model)}` : ""}
							{meta.effort ? ` · effort ${effortLabel(meta.effort)}` : ""}
						</TooltipContent>
					</Tooltip>
				) : (
					<Avatar info={info} size={28} />
				)}
			</MessageAvatar>
			<MessageContent>
				{msg.blocks.map(renderBlock)}
				{(streaming || msg.blocks.length === 0) && <ThinkingMarker />}
			</MessageContent>
		</MessageRoot>
	);
}
