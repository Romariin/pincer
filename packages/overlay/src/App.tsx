import type { ReactNode } from "react";
import { useSocket } from "@/state/useSocket";
import { usePicker } from "@/dom/usePicker";
import { PickerLayer } from "./components/PickerLayer";
import { Panel } from "./components/Panel";
import { TooltipProvider } from "./components/ui/tooltip";

export function App(): ReactNode {
  useSocket();
  const picker = usePicker();
  return (
    <TooltipProvider delay={120}>
      <PickerLayer hoverRect={picker.hoverRect} selectionRects={picker.selectionRects} />
      <Panel />
    </TooltipProvider>
  );
}
