import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { GAP } from "@/lib/constants";
import { formatShortcut } from "@/lib/shortcut";
import { usePincerStore } from "@/state/store";
import { Button } from "./ui/button";

const style: CSSProperties = {
	position: "fixed",
	right: GAP,
	bottom: `calc(${GAP}px + env(safe-area-inset-bottom))`,
	zIndex: 2147483647,
};

export function FloatingButton(): ReactNode {
	const panelOpen = usePincerStore((state) => state.panelOpen);
	const showFloatingButton = usePincerStore(
		(state) => state.showFloatingButton,
	);
	const shortcut = usePincerStore((state) => state.shortcut);
	const referenceCopyStatus = usePincerStore(
		(state) => state.referenceCopyStatus,
	);
	const setPanelOpen = usePincerStore((state) => state.setPanelOpen);
	const setSelecting = usePincerStore((state) => state.setSelecting);
	const startCopyingReference = usePincerStore(
		(state) => state.startCopyingReference,
	);
	if (panelOpen || !showFloatingButton) return null;

	const copying = referenceCopyStatus === "selecting";
	const copyFeedback =
		referenceCopyStatus === "copied"
			? "Reference copied"
			: referenceCopyStatus === "error"
				? "Could not copy reference"
				: "";

	return (
		<div
			className="inline-flex h-7 items-center gap-0.5 rounded-full border border-border bg-background p-0.5 text-foreground shadow-sm"
			style={style}
		>
			<Button
				variant={copying ? "secondary" : "ghost"}
				size="icon-sm"
				className="size-6 rounded-full"
				aria-label={
					copying
						? "Cancel copying element reference"
						: "Copy element reference"
				}
				title={copying ? "Cancel" : "Copy element reference"}
				onClick={() =>
					copying ? setSelecting(false) : startCopyingReference()
				}
			>
				{referenceCopyStatus === "copied" ? (
					<CheckIcon />
				) : referenceCopyStatus === "error" ? (
					<TriangleAlertIcon />
				) : (
					<CopyIcon />
				)}
			</Button>
			<span aria-hidden="true" className="h-3 w-px bg-border" />
			<Button
				variant="ghost"
				size="icon-sm"
				className="size-6 rounded-full text-[12px]"
				aria-label="Open Pincer"
				title={`Open Pincer (${formatShortcut(shortcut)})`}
				onClick={() => setPanelOpen(true)}
			>
				<span aria-hidden="true">🦀</span>
			</Button>
			<span className="sr-only" aria-live="polite">
				{copyFeedback}
			</span>
		</div>
	);
}
