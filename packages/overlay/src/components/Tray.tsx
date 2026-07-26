import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import { breadcrumb } from "@/dom/picker";
import { MONO } from "@/lib/constants";
import { Button } from "./ui/button";
import { CheckIcon, CopyIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";

export function Tray(): ReactNode {
  const selections = usePincerStore((s) => s.selections);
  const selecting = usePincerStore((s) => s.selecting);
  const setSelecting = usePincerStore((s) => s.setSelecting);
  const removeSelection = usePincerStore((s) => s.removeSelection);
  const referenceCopyStatus = usePincerStore((s) => s.referenceCopyStatus);
  const startCopyingReference = usePincerStore((s) => s.startCopyingReference);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [fades, setFades] = useState({ left: false, right: false });

  const updateFades = useCallback(() => {
    const n = scrollRef.current;
    if (!n) return;
    setFades({ left: n.scrollLeft > 2, right: n.scrollLeft + n.clientWidth < n.scrollWidth - 2 });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection changes require remeasuring the rendered chip row.
  useEffect(() => {
    updateFades();
  }, [selections, updateFades]);

  const has = selections.length > 0;
  const copying = referenceCopyStatus === "selecting";
  const attaching = selecting && !copying;
  const copyLabel =
    referenceCopyStatus === "copied"
      ? "Copied"
      : referenceCopyStatus === "error"
        ? "Try again"
        : copying
          ? "Select element"
          : "Copy reference";

  return (
    <div className="shrink-0 px-3 pb-0.5 pt-1.5">
      {/* Selected elements live on their own row, in a recessed strip above the actions. */}
      {has ? (
        <div className="relative mb-1.5 rounded-[10px] bg-muted px-2 py-1.5">
          <div
            ref={scrollRef}
            onScroll={updateFades}
            className="pcr-noscroll flex flex-nowrap gap-1.5 overflow-x-auto py-px"
          >
            {selections.map((sel) => (
              <span
                key={sel.id}
                style={{ fontFamily: MONO }}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-border/60 bg-background py-1 pl-2 pr-1 text-xs text-primary"
              >
                {breadcrumb(sel.domEl)}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-4 rounded-full text-primary hover:bg-primary/15 hover:text-primary"
                  aria-label="Remove element"
                  onClick={() => removeSelection(sel.domEl)}
                >
                  <XIcon />
                </Button>
              </span>
            ))}
          </div>
          {fades.left && (
            <span className="pointer-events-none absolute inset-y-0 left-0 w-6 rounded-l-[10px] bg-gradient-to-r from-muted to-transparent" />
          )}
          {fades.right && (
            <span className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-[10px] bg-gradient-to-l from-muted to-transparent" />
          )}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-1">
        <Button
          variant={copying ? "default" : "ghost"}
          size="icon"
          aria-label={copying ? "Cancel copying element reference" : "Copy element reference"}
          title={copying ? "Cancel" : "Pick an element and copy its source reference"}
          onClick={() => (copying ? setSelecting(false) : startCopyingReference())}
        >
          {referenceCopyStatus === "copied" ? (
            <CheckIcon />
          ) : referenceCopyStatus === "error" ? (
            <TriangleAlertIcon />
          ) : (
            <CopyIcon />
          )}
          <span className="sr-only" aria-live="polite">
            {copyLabel}
          </span>
        </Button>
        <Button
          variant={attaching ? "default" : "ghost"}
          size="sm"
          className="gap-1.5 text-[13px]"
          onClick={() => setSelecting(!attaching)}
        >
          <PlusIcon />
          Add element
        </Button>
      </div>
    </div>
  );
}
