import type { ReactNode } from "react";
import { usePicker } from "@/dom/usePicker";
import { useSocket } from "@/state/useSocket";
import { FloatingButton } from "./components/FloatingButton";
import { Panel } from "./components/Panel";
import { PickerLayer } from "./components/PickerLayer";
import { TooltipProvider } from "./components/ui/tooltip";

export function App(): ReactNode {
	useSocket();
	const picker = usePicker();
	return (
		<TooltipProvider delay={120}>
			<PickerLayer
				hoverRect={picker.hoverRect}
				selectionRects={picker.selectionRects}
			/>
			<Panel />
			<FloatingButton />
		</TooltipProvider>
	);
}
