import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { PANEL_MAX_W, PANEL_MIN_W, PANEL_W } from "@/lib/constants";
import { fitPanelWidth } from "@/lib/panelWidth";
import { usePincerStore } from "@/state/store";

const STEP = 16;
const COARSE_STEP = 64;

/** Drag strip on the panel's inner edge; the panel is docked right, so it grows leftwards. */
export function ResizeHandle(): ReactNode {
  const panelWidth = usePincerStore((s) => s.panelWidth);
  const resizing = usePincerStore((s) => s.resizingPanel);
  const setPanelWidth = usePincerStore((s) => s.setPanelWidth);
  const setResizingPanel = usePincerStore((s) => s.setResizingPanel);

  const resize = (width: number): void => setPanelWidth(fitPanelWidth(width, window.innerWidth));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = usePincerStore.getState().panelWidth;
    handle.setPointerCapture(event.pointerId);
    setResizingPanel(true);

    const onMove = (move: PointerEvent): void => resize(startWidth + (startX - move.clientX));
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setResizingPanel(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? COARSE_STEP : STEP;
    if (event.key === "ArrowLeft") resize(panelWidth + step);
    else if (event.key === "ArrowRight") resize(panelWidth - step);
    else if (event.key === "Home") resize(PANEL_MAX_W);
    else if (event.key === "End") resize(PANEL_MIN_W);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a window splitter must be focusable and host the drag indicator; <hr> is neither.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Pincer panel"
      aria-valuenow={panelWidth}
      aria-valuemin={PANEL_MIN_W}
      aria-valuemax={PANEL_MAX_W}
      tabIndex={0}
      data-resizing={resizing}
      title="Drag to resize — double-click to reset"
      className="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none outline-none max-[600px]:hidden"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => resize(PANEL_W)}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-0.5 bg-foreground opacity-0 transition-opacity group-hover:opacity-25 group-focus-visible:opacity-40 group-data-[resizing=true]:bg-primary group-data-[resizing=true]:opacity-100"
      />
    </div>
  );
}
