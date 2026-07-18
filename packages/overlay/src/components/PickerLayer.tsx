import type { CSSProperties, ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import type { Rect } from "@/dom/picker";
import type { PickerLayerState } from "@/dom/usePicker";

function boxStyle(rect: Rect): CSSProperties {
  return { position: "fixed", top: rect.top, left: rect.left, width: rect.width, height: rect.height, pointerEvents: "none" };
}

const PRIMARY = "var(--primary)";
const PRIMARY_FILL = "color-mix(in oklch, var(--primary) 12%, transparent)";
const PRIMARY_HOVER_FILL = "color-mix(in oklch, var(--primary) 10%, transparent)";

export function PickerLayer({ hoverRect, selectionRects }: PickerLayerState): ReactNode {
  const selecting = usePincerStore((s) => s.selecting);
  const panelOpen = usePincerStore((s) => s.panelOpen);

  return (
    <>
      {selectionRects.map(({ id, rect }) => (
        <div
          key={id}
          style={{
            ...boxStyle(rect),
            border: `2px solid ${PRIMARY}`,
            background: PRIMARY_FILL,
            borderRadius: 6,
            zIndex: 2147483645,
          }}
        />
      ))}
      {selecting && hoverRect && (
        <div
          style={{
            ...boxStyle(hoverRect),
            border: `1.5px solid ${PRIMARY}`,
            background: PRIMARY_HOVER_FILL,
            borderRadius: 6,
            zIndex: 2147483646,
          }}
        />
      )}
      {selecting && panelOpen && (
        <div
          className="font-sans"
          style={{
            position: "fixed",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2147483647,
            pointerEvents: "none",
            background: PRIMARY,
            color: "var(--primary-foreground)",
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.4,
            padding: "7px 14px",
            borderRadius: 999,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          Click elements to add them · Esc to stop
        </div>
      )}
    </>
  );
}
