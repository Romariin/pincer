import { relative, sep } from "node:path";
import type { NodePath, PluginItem } from "@babel/core";
import * as babel from "@babel/core";
import { formatSourceAttr, SOURCE_ATTR } from "@pincer/core";

const t = babel.types;

interface VisitorState {
	filename?: string;
}

/**
 * Contract A tagging visitor. Mounts into `@vitejs/plugin-react`'s Babel pass
 * and stamps host JSX elements with `data-pincer-source="<relpath>:<line>:<col>"`.
 */
export function pincerBabel(opts?: { root?: string }): PluginItem {
	return {
		visitor: {
			JSXOpeningElement(
				path: NodePath<babel.types.JSXOpeningElement>,
				state: VisitorState,
			): void {
				const name = path.node.name;
				if (name.type !== "JSXIdentifier") return;

				const tag = name.name;
				if (!/^[a-z]/.test(tag) || tag === "Fragment") return;

				const already = path.node.attributes.some(
					(attr) =>
						attr.type === "JSXAttribute" &&
						attr.name.type === "JSXIdentifier" &&
						attr.name.name === SOURCE_ATTR,
				);
				if (already) return;

				const loc = path.node.loc?.start;
				if (!loc) return;

				const root = opts?.root ?? process.cwd();
				const filename = state.filename;
				if (!filename) return;

				const rel = relative(root, filename).split(sep).join("/");

				path.pushContainer(
					"attributes",
					t.jsxAttribute(
						t.jsxIdentifier(SOURCE_ATTR),
						t.stringLiteral(
							formatSourceAttr({
								path: rel,
								line: loc.line,
								column: loc.column,
							}),
						),
					),
				);
			},
		},
	};
}
