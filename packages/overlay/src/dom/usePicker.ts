import { useCallback, useEffect, useState } from "react";
import { useRoot } from "@/context/root";
import { usePincerStore } from "@/state/store";
import { place, type Rect } from "./picker";

export interface PickerLayerState {
  hoverRect: Rect | null;
  selectionRects: Rect[];
}

/**
 * Installs the capture-phase element-picker listeners on `window`. Events from
 * inside the shadow root are retargeted to the host, so `composedPath()` gives
 * the true target and lets us ignore the overlay's own UI (any path through the
 * host element).
 */
export function usePicker(): PickerLayerState {
  const { host } = useRoot();
  const selecting = usePincerStore((s) => s.selecting);
  const selections = usePincerStore((s) => s.selections);
  const [hoverRect, setHoverRect] = useState<Rect | null>(null);
  const [selectionRects, setSelectionRects] = useState<Rect[]>([]);

  const recomputeSelections = useCallback(() => {
    setSelectionRects(usePincerStore.getState().selections.map((s) => place(s.domEl)));
  }, []);

  useEffect(() => {
    recomputeSelections();
  }, [selections, recomputeSelections]);

  useEffect(() => {
    if (!selecting) setHoverRect(null);
  }, [selecting]);

  useEffect(() => {
    const overlayTarget = (e: Event): HTMLElement | null => {
      const path = e.composedPath();
      const target = path[0];
      if (!(target instanceof HTMLElement) || path.includes(host)) return null;
      return target;
    };

    const onMove = (e: MouseEvent): void => {
      if (!usePincerStore.getState().selecting) return;
      const target = overlayTarget(e);
      setHoverRect(target ? place(target) : null);
    };
    const onClick = (e: MouseEvent): void => {
      if (!usePincerStore.getState().selecting) return;
      const target = overlayTarget(e);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      usePincerStore.getState().toggleSelect(target);
    };
    const onReposition = (): void => recomputeSelections();

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition, true);
    };
  }, [host, recomputeSelections]);

  return { hoverRect, selectionRects };
}
