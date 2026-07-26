import { ChevronLeftIcon, SettingsIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import { Button } from "./ui/button";

export function Header(): ReactNode {
	const view = usePincerStore((s) => s.view);
	const setView = usePincerStore((s) => s.setView);
	const setPanelOpen = usePincerStore((s) => s.setPanelOpen);
	const openSettings = usePincerStore((s) => s.openSettings);

	// Floating controls: no bar, no title. The container ignores pointer events so the
	// view underneath stays clickable everywhere except on the buttons themselves.
	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-[9px] p-3">
			{(view === "chat" || view === "settings") && (
				<Button
					variant="outline"
					size="icon"
					className="pointer-events-auto bg-background"
					aria-label="Back to conversations"
					onClick={() => setView("list")}
				>
					<ChevronLeftIcon />
				</Button>
			)}
			<span className="flex-1" />
			{view !== "settings" && (
				<Button
					variant="outline"
					size="icon"
					className="pointer-events-auto bg-background"
					aria-label="Open settings"
					onClick={openSettings}
				>
					<SettingsIcon />
				</Button>
			)}
			<Button
				variant="outline"
				size="icon"
				className="pointer-events-auto bg-background"
				aria-label="Close Pincer"
				onClick={() => setPanelOpen(false)}
			>
				<XIcon />
			</Button>
		</div>
	);
}
