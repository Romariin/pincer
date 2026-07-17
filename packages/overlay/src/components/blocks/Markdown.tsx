import type { ReactNode } from "react";
import { renderMarkdown } from "../../blocks";

export function Markdown({ text }: { text: string }): ReactNode {
  return <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
