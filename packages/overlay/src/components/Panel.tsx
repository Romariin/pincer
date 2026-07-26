import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import { matchesShortcut } from "@/lib/shortcut";
import { fitPanelWidth } from "@/lib/panelWidth";
import { Header } from "./Header";
import { ResizeHandle } from "./ResizeHandle";
import { CommandBar } from "./CommandBar";
import { ListView } from "./ListView";
import { ChatView } from "./ChatView";
import { SettingsView } from "./SettingsView";
import { Tray } from "./Tray";
import { Composer } from "./Composer";
import { Picker } from "./Picker";
import { OverlayContainerProvider } from "@/context/overlay";

export function Panel(): ReactNode {
  const panelOpen = usePincerStore((s) => s.panelOpen);
  const panelWidth = usePincerStore((s) => s.panelWidth);
  const resizing = usePincerStore((s) => s.resizingPanel);
  const view = usePincerStore((s) => s.view);
  const pickerContainer = useRef<HTMLDivElement>(null);
  const pushed = useRef({ margin: "", transform: "", transition: "", ownMargin: 0 });

  // Push side effect: narrow the host page while the panel is open. The transform makes
  // <body> the containing block of its fixed/absolute descendants, so app headers, modals
  // and toasts move aside too instead of sliding under the panel. Capture/restore lives in
  // its own effect so a width change never records our own values as the page's.
  useEffect(() => {
    if (!panelOpen) return;
    const body = document.body;
    pushed.current = {
      margin: body.style.marginRight,
      transform: body.style.transform,
      transition: body.style.transition,
      // Keep whatever right margin the page already had; ours stacks on top of it.
      ownMargin: Number.parseFloat(getComputedStyle(body).marginRight) || 0,
    };
    return () => {
      body.style.marginRight = pushed.current.margin;
      body.style.transform = pushed.current.transform;
      body.style.transition = pushed.current.transition;
    };
  }, [panelOpen]);

  // Keep the push in sync with the panel's width; drags skip the easing so the page tracks the cursor.
  useEffect(() => {
    if (!panelOpen) return;
    const body = document.body;
    const apply = (): void => {
      body.style.transition = resizing ? "none" : "margin-right 0.5s cubic-bezier(.32,.72,0,1)";
      body.style.transform = "translateX(0)";
      // The sidebar is flush against the edge, so the push equals its width exactly:
      // nothing of the host page ends up underneath it.
      const push =
        window.innerWidth < 600 ? 0 : fitPanelWidth(panelWidth, window.innerWidth);
      body.style.marginRight = `${pushed.current.ownMargin + push}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [panelOpen, panelWidth, resizing]);

  // Global toggle key + Escape handling (capture phase, so it wins over the host page).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const s = usePincerStore.getState();
      if (s.recordingShortcut) return;
      if (matchesShortcut(s.shortcut, e)) {
        e.preventDefault();
        s.setPanelOpen(!s.panelOpen);
        return;
      }
      if (e.key === "Escape") {
        if (s.picker) s.closePicker();
        else if (s.selecting) s.setSelecting(false);
        else if ((s.view === "settings" || s.view === "chat") && s.panelOpen) s.setView("list");
        else if (s.panelOpen) s.setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const style: CSSProperties = {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: panelWidth,
    maxWidth: "100vw",
    zIndex: 2147483647,
    transform: panelOpen ? "none" : "translateX(100%)",
    opacity: panelOpen ? 1 : 0,
    pointerEvents: panelOpen ? "auto" : "none",
    transition: resizing ? "none" : "transform .5s cubic-bezier(.32,.72,0,1),opacity .35s ease",
    fontSize: 14,
    letterSpacing: "-0.006em",
  };

  return (
    <div
      className="pcr-panel flex flex-col overflow-hidden border-border border-l bg-background font-sans text-foreground"
      style={style}
    >
      <OverlayContainerProvider value={pickerContainer}>
        <ResizeHandle />
        <Header />
        {view === "settings" ? (
          <SettingsView />
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col">
              {view === "list" ? <ListView /> : <ChatView />}
            </div>
            <Tray />
            <Composer />
            <CommandBar />
          </>
        )}
        <div ref={pickerContainer} className="pointer-events-none absolute inset-0 contain-layout" />
        <Picker container={pickerContainer} />
      </OverlayContainerProvider>
    </div>
  );
}
