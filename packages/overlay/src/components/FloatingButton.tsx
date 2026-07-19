import type { CSSProperties, ReactNode } from "react";
import { formatShortcut } from "@/lib/shortcut";
import { GAP } from "@/lib/constants";
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
  const showFloatingButton = usePincerStore((state) => state.showFloatingButton);
  const shortcut = usePincerStore((state) => state.shortcut);
  const setPanelOpen = usePincerStore((state) => state.setPanelOpen);
  if (panelOpen || !showFloatingButton) return null;

  return (
    <Button
      className="size-11 rounded-full text-[18px] shadow-md"
      style={style}
      aria-label="Open Pincer"
      title={`Open Pincer (${formatShortcut(shortcut)})`}
      onClick={() => setPanelOpen(true)}
    >
      <span aria-hidden="true">🦀</span>
    </Button>
  );
}
