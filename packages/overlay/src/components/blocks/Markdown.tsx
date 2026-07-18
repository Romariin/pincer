import type { ReactNode } from "react";
import { renderMarkdown } from "../../blocks";

export function Markdown({ text }: { text: string }): ReactNode {
  // biome-ignore-start lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes all user-provided text before adding controlled markup.
  return <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  // biome-ignore-end lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes all user-provided text before adding controlled markup.
}
