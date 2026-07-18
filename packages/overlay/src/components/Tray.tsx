import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import { breadcrumb } from "@/dom/picker";
import { MONO } from "@/lib/constants";
import { Button } from "./ui/button";
import { PlusIcon, XIcon } from "lucide-react";

export function Tray(): ReactNode {
  const selections = usePincerStore((s) => s.selections);
  const selecting = usePincerStore((s) => s.selecting);
  const setSelecting = usePincerStore((s) => s.setSelecting);
  const removeSelection = usePincerStore((s) => s.removeSelection);

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

  return (
    <div className="flex min-h-[40px] shrink-0 items-center gap-2 px-3 pb-0.5 pt-1.5">
      {has ? (
        <div className="relative min-w-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={updateFades}
            className="pcr-noscroll flex flex-nowrap gap-1.5 overflow-x-auto py-px"
          >
            {selections.map((sel) => (
              <span
                key={sel.id}
                style={{ fontFamily: MONO }}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-primary/40 bg-primary/15 py-1 pl-2 pr-1 text-xs text-primary"
              >
                {breadcrumb(sel.domEl)}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-4 rounded-full text-primary hover:bg-primary/25 hover:text-primary"
                  onClick={() => removeSelection(sel.domEl)}
                >
                  <XIcon />
                </Button>
              </span>
            ))}
          </div>
          {fades.left && (
            <span className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent" />
          )}
          {fades.right && (
            <span className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent" />
          )}
        </div>
      ) : (
        <span className="flex-1 text-[13px] text-muted-foreground">No elements selected</span>
      )}
      <Button
        variant={selecting ? "default" : "secondary"}
        size="sm"
        className="shrink-0 gap-1.5 text-[13px]"
        onClick={() => setSelecting(!selecting)}
      >
        <PlusIcon />
        Add element
      </Button>
    </div>
  );
}
