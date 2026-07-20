import type { PromptElement } from "@pincer/core";
import type { HarnessTurnRequest } from "./types";

/** Build the deterministic prompt handed to a coding CLI Harness. */
export function composePrompt(request: HarnessTurnRequest): string {
	const { source, domContext, prompt, elements } = request;
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
	targets.forEach((target, index) => {
		const prefix = many ? `${index + 1}. ` : "";
		const indent = many ? "   " : "";
		if (target.source) {
			lines.push(
				`${prefix}Source: ${target.source.path} (line ${target.source.line}, column ${target.source.column})`,
			);
		} else {
			lines.push(
				`${prefix}Source mapping was unavailable; use the DOM context below to locate it.`,
			);
		}
		const idPart = target.domContext.id ? `#${target.domContext.id}` : "";
		const classPart =
			target.domContext.classes.length > 0
				? `.${target.domContext.classes.join(".")}`
				: "";
		const textPart = target.domContext.text ? ` ${target.domContext.text}` : "";
		lines.push(
			`${indent}Element: <${target.domContext.tag}${idPart}${classPart}>${textPart}`,
		);
		lines.push(
			`${indent}DOM ancestry: ${target.domContext.ancestry.join(" > ")}`,
		);
	});
	lines.push("");
	lines.push("Requested change:");
	lines.push('"""');
	lines.push(prompt);
	lines.push('"""');
	lines.push("");
	lines.push(
		"Make the smallest change that satisfies the request. Do not reformat unrelated code.",
	);
	return lines.join("\n");
}
