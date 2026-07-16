import type { AgentTask } from "@pincer/core";

/** Build the deterministic prompt handed to the CLI agent. */
export function composePrompt(task: AgentTask): string {
  const { source, domContext, prompt } = task;
  const lines: string[] = [];
  lines.push(
    "You are editing a running web app via Pincer. The developer clicked an element in the browser preview and requested a change. Edit the source files directly; the dev server has HMR, so do not start or restart any server.",
  );
  lines.push("");
  if (source) {
    lines.push(`Selected element source: ${source.path} (line ${source.line}, column ${source.column})`);
  } else {
    lines.push("Source mapping was unavailable for this element; use the DOM context below to locate it.");
  }
  const idPart = domContext.id ? `#${domContext.id}` : "";
  const classPart = domContext.classes.length > 0 ? "." + domContext.classes.join(".") : "";
  const textPart = domContext.text ? ` ${domContext.text}` : "";
  lines.push(`Element: <${domContext.tag}${idPart}${classPart}>${textPart}`);
  lines.push(`DOM ancestry: ${domContext.ancestry.join(" > ")}`);
  lines.push("");
  lines.push("Requested change:");
  lines.push('"""');
  lines.push(prompt);
  lines.push('"""');
  lines.push("");
  lines.push("Make the smallest change that satisfies the request. Do not reformat unrelated code.");
  return lines.join("\n");
}
