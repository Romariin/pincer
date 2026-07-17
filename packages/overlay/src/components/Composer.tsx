import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PROTOCOL_VERSION } from "@pincer/core";
import type { PromptElement } from "@pincer/core";
import { usePincerStore } from "@/state/store";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function Composer(): ReactNode {
  const view = usePincerStore((s) => s.view);
  const turnRunning = usePincerStore((s) => s.turnRunning);

  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (view !== "chat") return;
    const t = setTimeout(() => taRef.current?.focus(), 260);
    return () => clearTimeout(t);
  }, [view]);

  const submit = (): void => {
    const s = usePincerStore.getState();
    if (s.turnRunning) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const elements: PromptElement[] = s.selections.map((sel) => ({ source: sel.source, domContext: sel.domContext }));
    const primary = elements[0] ?? {
      source: null,
      domContext: { tag: "page", id: null, classes: [], text: null, ancestry: [] },
    };
    const payload = { prompt: trimmed, source: primary.source, domContext: primary.domContext, elements };
    setText("");
    s.clearSelections();
    if (s.view === "chat" && s.conversationId) {
      s.send({ v: PROTOCOL_VERSION, type: "prompt", conversationId: s.conversationId, ...payload });
      s.addUserMessage(trimmed, elements.length);
    } else {
      s.setPendingPrompt(payload);
      s.send({ v: PROTOCOL_VERSION, type: "new_conversation", ...s.draft });
    }
  };

  const onSend = (): void => {
    const s = usePincerStore.getState();
    if (s.turnRunning && s.conversationId) {
      s.send({ v: PROTOCOL_VERSION, type: "cancel", conversationId: s.conversationId });
    } else {
      submit();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 px-3 pb-3.5 pt-2">
      <Textarea
        ref={taRef}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          view === "chat" ? "Describe the change… (⌘/Ctrl+Enter to send)" : "Describe a change to start a new chat…"
        }
      />
      <div className="mt-2.5 flex gap-2">
        <Button className="flex-1" size="lg" variant={turnRunning ? "secondary" : "default"} onClick={onSend}>
          {turnRunning ? "Stop" : "Send"}
        </Button>
      </div>
    </div>
  );
}
