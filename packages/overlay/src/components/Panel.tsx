import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import { matchesToggle, parseToggleKey } from "@/lib/config";
import { GAP, PANEL_W } from "@/lib/constants";
import { Header } from "./Header";
import { CommandBar } from "./CommandBar";
import { ListView } from "./ListView";
import { ChatView } from "./ChatView";
import { Tray } from "./Tray";
import { Composer } from "./Composer";
import { Picker } from "./Picker";
import { OverlayContainerProvider } from "@/context/overlay";

export function Panel(): ReactNode {
  const panelOpen = usePincerStore((s) => s.panelOpen);
  const view = usePincerStore((s) => s.view);
  const pickerContainer = useRef<HTMLDivElement>(null);
  const prevMargin = useRef("");
  const prevTransition = useRef("");

  // Margin-push side effect: shove the host page left while the panel is open (verbatim port).
  useEffect(() => {
    const root = document.documentElement;
    if (panelOpen) {
      prevMargin.current = root.style.marginRight;
      prevTransition.current = root.style.transition;
      root.style.transition = "margin-right 0.5s cubic-bezier(.32,.72,0,1)";
      root.style.marginRight = `${window.innerWidth < 600 ? 0 : PANEL_W + GAP * 2}px`;
    } else {
      root.style.marginRight = prevMargin.current;
      root.style.transition = prevTransition.current;
    }
  }, [panelOpen]);

  // Global toggle key + Escape handling (capture phase, so it wins over the host page).
  useEffect(() => {
    const toggle = parseToggleKey(window.__PINCER__?.toggleKey);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (matchesToggle(toggle, e)) {
        e.preventDefault();
        const s = usePincerStore.getState();
        s.setPanelOpen(!s.panelOpen);
        return;
      }
      if (e.key === "Escape") {
        const s = usePincerStore.getState();
        if (s.picker) s.closePicker();
        else if (s.selecting) s.setSelecting(false);
        else if (s.view === "chat" && s.panelOpen) s.setView("list");
        else if (s.panelOpen) s.setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const style: CSSProperties = {
    position: "fixed",
    top: GAP,
    right: GAP,
    bottom: GAP,
    width: PANEL_W,
    zIndex: 2147483647,
    transform: panelOpen ? "none" : `translateX(calc(100% + ${GAP * 2}px))`,
    opacity: panelOpen ? 1 : 0,
    pointerEvents: panelOpen ? "auto" : "none",
    transition: "transform .5s cubic-bezier(.32,.72,0,1),opacity .35s ease",
    fontSize: 14,
    letterSpacing: "-0.006em",
  };

  return (
    <div
      className="pcr-panel flex flex-col overflow-hidden rounded-[20px] border border-border bg-background font-sans text-foreground shadow-2xl"
      style={style}
    >
      <OverlayContainerProvider value={pickerContainer}>
        <Header />
        <CommandBar />
        <div className="flex min-h-0 flex-1 flex-col">
          {view === "list" ? <ListView /> : <ChatView />}
        </div>
        <Tray />
        <Composer />
        <div ref={pickerContainer} className="pointer-events-none absolute inset-0 contain-layout" />
        <Picker container={pickerContainer} />
      </OverlayContainerProvider>
    </div>
  );
}
