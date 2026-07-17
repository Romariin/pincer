import type { ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import { Button } from "./ui/button";
import { ChevronLeftIcon, XIcon } from "lucide-react";

export function Header(): ReactNode {
  const view = usePincerStore((s) => s.view);
  const setView = usePincerStore((s) => s.setView);
  const setPanelOpen = usePincerStore((s) => s.setPanelOpen);

  return (
    <div className="flex shrink-0 items-center gap-[9px] border-b border-border p-3">
      {view === "chat" && (
        <Button variant="outline" size="icon" onClick={() => setView("list")}>
          <ChevronLeftIcon />
        </Button>
      )}
      <span className="text-[17px] leading-none">🦀</span>
      <span className="text-base font-bold">Pincer</span>
      <span className="flex-1" />
      <Button variant="outline" size="icon" onClick={() => setPanelOpen(false)}>
        <XIcon />
      </Button>
    </div>
  );
}
