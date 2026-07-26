import type { HarnessDisplay } from "@pincer/core";
import { type CSSProperties, type ReactNode, useId, useMemo } from "react";
import { MONO } from "@/lib/constants";

/** Resize the harness's raw SVG icon and uniquify its gradient ids so multiple avatars never collide. */
function prepareIcon(iconHtml: string, size: number, uid: string): string {
	const div = document.createElement("div");
	div.innerHTML = iconHtml;
	const svg = div.querySelector("svg");
	if (svg) {
		const iconSize = Math.round(size * 0.6);
		svg.setAttribute("width", String(iconSize));
		svg.setAttribute("height", String(iconSize));
		svg.style.display = "block";
		svg
			.querySelectorAll("linearGradient[id],radialGradient[id]")
			.forEach((g) => {
				const old = g.getAttribute("id");
				if (!old) return;
				const nid = `${uid}-${old}`;
				g.setAttribute("id", nid);
				svg.querySelectorAll(`[fill="url(#${old})"]`).forEach((n) => {
					n.setAttribute("fill", `url(#${nid})`);
				});
			});
	}
	return div.innerHTML;
}

export function Avatar({
	info,
	size,
}: {
	info: HarnessDisplay;
	size: number;
}): ReactNode {
	const rawUid = useId();
	const uid = useMemo(
		() => `pcr-ic-${rawUid.replace(/[^a-zA-Z0-9]/g, "")}`,
		[rawUid],
	);
	const iconHtml = useMemo(
		() => (info.icon ? prepareIcon(info.icon, size, uid) : null),
		[info.icon, size, uid],
	);
	const radius = "50%";

	const base: CSSProperties = {
		flex: "0 0 auto",
		width: size,
		height: size,
		borderRadius: radius,
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
	};

	if (iconHtml !== null) {
		// biome-ignore-start lint/security/noDangerouslySetInnerHtml: Harness icons are trusted SVG constants supplied by the local daemon catalog.
		return (
			<span
				style={{
					...base,
					background: "transparent",
					boxShadow: "inset 0 0 0 1px var(--border)",
				}}
				dangerouslySetInnerHTML={{ __html: iconHtml }}
			/>
		);
		// biome-ignore-end lint/security/noDangerouslySetInnerHtml: Harness icons are trusted SVG constants supplied by the local daemon catalog.
	}

	return (
		<span
			style={{
				...base,
				background: `linear-gradient(145deg,${info.c1},${info.c2})`,
				color: "#fff",
				fontSize: Math.round(size * 0.42),
				fontWeight: 700,
				fontFamily: MONO,
				letterSpacing: "-0.02em",
			}}
		>
			{info.glyph}
		</span>
	);
}
