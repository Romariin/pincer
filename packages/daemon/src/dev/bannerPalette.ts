import { CSI } from "./ansi";

/** Full-saturation hue → rgb; the banner only ever wants vivid colors. */
function hueToRgb(hue: number): [number, number, number] {
	const sector = (((hue % 1) + 1) % 1) * 6;
	const ramp = Math.round(255 * (1 - Math.abs((sector % 2) - 1)));
	if (sector < 1) return [255, ramp, 0];
	if (sector < 2) return [ramp, 255, 0];
	if (sector < 3) return [0, 255, ramp];
	if (sector < 4) return [0, ramp, 255];
	if (sector < 5) return [ramp, 0, 255];
	return [255, 0, ramp];
}

// The gradient walks one arc of the wheel — indigo → violet → magenta → pink →
// amber — instead of the whole ring: greens and cyans make a terminal box look
// like a toy. 1.08 wraps past red into orange, which is why it exceeds 1.
const ARC_START = 0.72;
const ARC_END = 1.08;

/**
 * Arc position 0..1 → hue. The wave ping-pongs across the arc rather than
 * looping through the excluded hues, so the animation has no seam where the
 * gradient would otherwise snap back.
 */
function arcHue(position: number): number {
	const wrapped = ((position % 1) + 1) % 1;
	const pingPong = wrapped < 0.5 ? wrapped * 2 : 2 - wrapped * 2;
	return ARC_START + (ARC_END - ARC_START) * pingPong;
}

/** Same arc in 256-color space, indigo → amber, for terminals without truecolor. */
const ARC_256 = [63, 99, 135, 171, 207, 205, 199, 198, 204, 210, 209, 215, 221];

export function arcForeground(position: number, truecolor: boolean): string {
	const hue = arcHue(position);
	if (truecolor) {
		const [r, g, b] = hueToRgb(hue);
		return `${CSI}38;2;${r};${g};${b}m`;
	}
	const step = (hue - ARC_START) / (ARC_END - ARC_START);
	const index = Math.min(ARC_256.length - 1, Math.floor(step * ARC_256.length));
	return `${CSI}38;5;${ARC_256[index] ?? ARC_256[0]}m`;
}
