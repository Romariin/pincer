import type { ReactNode } from "react";
import { usePincerStore } from "@/state/store";
import { Message } from "./Message";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "./ui/message-scroller";

export function ChatView(): ReactNode {
  const messages = usePincerStore((s) => s.messages);
  const streamingIndex = usePincerStore((s) => s.streamingIndex);

  if (!messages.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-full flex-col items-center justify-center gap-[14px] px-[30px] py-10 text-center text-muted-foreground">
          <span className="text-[34px] opacity-85">🦀</span>
          <div className="text-sm leading-[1.6] text-muted-foreground">
            Ready when you are.
            <br />
            Add an element or describe a change,
            <br />
            then hit{" "}
            <span className="font-semibold text-primary">
              Send
            </span>
            .
          </div>
        </div>
      </div>
    );
  }

  return (
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-[18px] px-[14px] pb-2 pt-4">
            {messages.map((m, i) => (
              <MessageScrollerItem key={m.id} messageId={String(m.id)} scrollAnchor={m.role === "user"}>
                <Message msg={m} streaming={i === streamingIndex} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
