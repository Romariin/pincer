import type { AgentTask, PromptElement } from "@pincer/core";

/** Build the deterministic prompt handed to the CLI agent. */
export function composePrompt(task: AgentTask): string {
  const { source, domContext, prompt, elements } = task;
  const targets: PromptElement[] =
    elements && elements.length > 0 ? elements : [{ source, domContext }];
  const many = targets.length > 1;

  const lines: string[] = [];
  lines.push(
    `You are editing a running web app via Pincer. The developer clicked ${
      many ? `${targets.length} elements` : "an element"
    } in the browser preview and requested a change. Edit the source files directly; the dev server has HMR, so do not start or restart any server.`,
  );
  lines.push("");
  lines.push(many ? "Selected elements:" : "Selected element:");
  targets.forEach((t, i) => {
    const prefix = many ? `${i + 1}. ` : "";
    const indent = many ? "   " : "";
    if (t.source) {
      lines.push(`${prefix}Source: ${t.source.path} (line ${t.source.line}, column ${t.source.column})`);
    } else {
      lines.push(`${prefix}Source mapping was unavailable; use the DOM context below to locate it.`);
    }
    const idPart = t.domContext.id ? `#${t.domContext.id}` : "";
    const classPart = t.domContext.classes.length > 0 ? `.${t.domContext.classes.join(".")}` : "";
    const textPart = t.domContext.text ? ` ${t.domContext.text}` : "";
    lines.push(`${indent}Element: <${t.domContext.tag}${idPart}${classPart}>${textPart}`);
    lines.push(`${indent}DOM ancestry: ${t.domContext.ancestry.join(" > ")}`);
  });
  lines.push("");
  lines.push("Requested change:");
  lines.push('"""');
  lines.push(prompt);
  lines.push('"""');
  lines.push("");
  lines.push("Make the smallest change that satisfies the request. Do not reformat unrelated code.");
  return lines.join("\n");
}
