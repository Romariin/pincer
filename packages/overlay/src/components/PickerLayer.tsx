import type { CSSProperties, ReactNode } from "react";
import type { Rect } from "@/dom/picker";
import type { PickerLayerState } from "@/dom/usePicker";
import { usePincerStore } from "@/state/store";

function boxStyle(rect: Rect): CSSProperties {
	return {
		position: "fixed",
		top: rect.top,
		left: rect.left,
		width: rect.width,
		height: rect.height,
		pointerEvents: "none",
	};
}

const PRIMARY = "var(--primary)";
const PRIMARY_FILL = "color-mix(in oklch, var(--primary) 12%, transparent)";
const PRIMARY_HOVER_FILL =
	"color-mix(in oklch, var(--primary) 10%, transparent)";
const INSTRUCTION_STYLE: CSSProperties = {
	position: "fixed",
	top: 10,
	left: "50%",
	transform: "translateX(-50%)",
	zIndex: 2147483647,
	pointerEvents: "none",
	background: "var(--background)",
	border: "1px solid var(--border)",
	fontSize: 12,
	fontWeight: 500,
	lineHeight: 1.25,
	padding: "4px 8px",
	borderRadius: 6,
	boxShadow: "0 2px 6px rgba(0,0,0,0.24)",
};

export function PickerLayer({
	hoverRect,
	selectionRects,
}: PickerLayerState): ReactNode {
	const selecting = usePincerStore((s) => s.selecting);
	const referenceCopyStatus = usePincerStore((s) => s.referenceCopyStatus);

	const copying = referenceCopyStatus === "selecting";
	const instruction = copying
		? "Select an element to copy · Esc to cancel"
		: "Select elements · Esc to finish";
	return (
		<>
			{selectionRects.map(({ id, rect }) => (
				<div
					key={id}
					style={{
						...boxStyle(rect),
						border: `2px solid ${PRIMARY}`,
						background: PRIMARY_FILL,
						borderRadius: 6,
						zIndex: 2147483645,
					}}
				/>
			))}
			{selecting && hoverRect && (
				<div
					style={{
						...boxStyle(hoverRect),
						border: `1.5px solid ${PRIMARY}`,
						background: PRIMARY_HOVER_FILL,
						borderRadius: 6,
						zIndex: 2147483646,
					}}
				/>
			)}
			{selecting && (
				<div className="font-sans text-foreground" style={INSTRUCTION_STYLE}>
					{instruction}
				</div>
			)}
		</>
	);
}
