import type { ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import { Button } from "./ui/button";
import { ChevronLeftIcon, SettingsIcon, XIcon } from "lucide-react";

export function Header(): ReactNode {
  const view = usePincerStore((s) => s.view);
  const setView = usePincerStore((s) => s.setView);
  const setPanelOpen = usePincerStore((s) => s.setPanelOpen);
  const openSettings = usePincerStore((s) => s.openSettings);

  return (
    <div className="flex shrink-0 items-center gap-[9px] border-b border-border p-3">
      {(view === "chat" || view === "settings") && (
        <Button
          variant="outline"
          size="icon"
          aria-label="Back to conversations"
          onClick={() => setView("list")}
        >
          <ChevronLeftIcon />
        </Button>
      )}
      <span className="text-[17px] leading-none">🦀</span>
      <span className="text-base font-bold">Pincer</span>
      <span className="flex-1" />
      {view !== "settings" && (
        <Button variant="outline" size="icon" aria-label="Open settings" onClick={openSettings}>
          <SettingsIcon />
        </Button>
      )}
      <Button
        variant="outline"
        size="icon"
        aria-label="Close Pincer"
        onClick={() => setPanelOpen(false)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
