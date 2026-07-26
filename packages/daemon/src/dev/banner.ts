import { CLEAR_EOL, CSI, CURSOR_HIDE, CURSOR_SHOW, RESET } from "./ansi";
import { arcForeground } from "./bannerPalette";

/**
 * The banner is described as styled segments instead of pre-joined strings: the
 * plain render concatenates the text, the color render walks the very same
 * characters column by column so a hue wave can cross the whole box, and the
 * animation blanks trailing columns to wipe the box in. All three stay aligned
 * by construction, so stripping ANSI from any frame yields the plain banner.
 */
type BannerStyle = "frame" | "title" | "url" | "label" | "dim" | "blank";

interface BannerSegment {
	text: string;
	style: BannerStyle;
}

function layoutBanner(proxyUrl: string, target: string): BannerSegment[][] {
	const rows: BannerSegment[][] = [
		[],
		[{ text: "Open this URL (Pincer proxy):", style: "label" }],
		[{ text: proxyUrl, style: "url" }],
		[],
		[{ text: `Upstream dev server: ${target}`, style: "dim" }],
		[],
	];
	const textWidth = (row: BannerSegment[]): number =>
		row.reduce((sum, seg) => sum + seg.text.length, 0);
	// 2 leading + 2 trailing spaces of gutter.
	const innerWidth = Math.max(44, ...rows.map((row) => textWidth(row) + 4));
	const blank = (n: number): BannerSegment => ({
		text: " ".repeat(n),
		style: "blank",
	});
	const frame = (text: string): BannerSegment => ({ text, style: "frame" });

	return [
		[
			frame("╭─ "),
			{ text: "PINCER ACTIVE", style: "title" },
			frame(` ${"─".repeat(innerWidth - 16)}╮`),
		],
		...rows.map((row) => [
			frame("│"),
			blank(2),
			...row,
			blank(innerWidth - 2 - textWidth(row)),
			frame("│"),
		]),
		[frame(`╰${"─".repeat(innerWidth)}╯`)],
	];
}

const STYLE_ATTRS: Record<BannerStyle, string> = {
	frame: "",
	title: `${CSI}1m`,
	url: `${CSI}1;4m`,
	label: `${CSI}1;97m`,
	dim: `${CSI}2m`,
	blank: "",
};

// The gradient carries the frame, the title and the URL; prose stays a steady
// color so the box reads as text and not as a screensaver.
const GRADIENT_STYLES = new Set<BannerStyle>(["frame", "title", "url"]);

// Arc position is snapped to this many steps so neighbouring cells share one
// escape and each animation frame stays a couple of KB instead of ten.
const GRADIENT_STEPS = 48;

export interface BannerStyleOptions {
	/** Offset of the gradient wave, in arc turns; the animation walks this. */
	phase?: number;
	truecolor?: boolean;
	/** How many columns to draw; the rest is blanked so the box wipes in. */
	reveal?: number;
}

export function formatReadyBanner(
	proxyUrl: string,
	target: string,
	color: boolean,
	style: BannerStyleOptions = {},
): string {
	const lines = layoutBanner(proxyUrl, target);
	if (!color)
		return lines.map((line) => line.map((seg) => seg.text).join("")).join("\n");

	const {
		phase = 0,
		truecolor = true,
		reveal = Number.POSITIVE_INFINITY,
	} = style;
	const [topLine = []] = lines;
	const width = topLine.reduce((sum, seg) => sum + seg.text.length, 0) || 1;

	return lines
		.map((line, row) => {
			let out = "";
			let col = 0;
			let open = "";
			for (const seg of line) {
				for (const char of seg.text) {
					const hidden = col >= reveal;
					// Diagonal wave: the arc drifts along the row and down the box.
					const position =
						Math.round(
							((col / width) * 0.55 + row * 0.04 + phase) * GRADIENT_STEPS,
						) / GRADIENT_STEPS;
					const want =
						hidden || seg.style === "blank"
							? ""
							: GRADIENT_STYLES.has(seg.style)
								? STYLE_ATTRS[seg.style] + arcForeground(position, truecolor)
								: STYLE_ATTRS[seg.style];
					if (want !== open) {
						if (open) out += RESET;
						out += want;
						open = want;
					}
					out += hidden ? " " : char;
					col += 1;
				}
			}
			return open ? out + RESET : out;
		})
		.join("\n");
}

export interface PrintBannerOptions {
	proxyUrl: string;
	target: string;
	color: boolean;
	truecolor?: boolean;
	animate?: boolean;
	frames?: number;
	intervalMs?: number;
	write?: (chunk: string) => void;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Prints the banner once, or — on a color TTY — wipes it in and sweeps the
 * rainbow across it before settling. The resting frame is the plain static
 * gradient so scrollback keeps something readable.
 */
export async function printReadyBanner(
	opts: PrintBannerOptions,
): Promise<void> {
	const write =
		opts.write ?? ((chunk: string) => void process.stdout.write(chunk));
	const truecolor = opts.truecolor ?? true;
	const render = (style: BannerStyleOptions): string =>
		formatReadyBanner(opts.proxyUrl, opts.target, opts.color, {
			truecolor,
			...style,
		});

	if (!opts.color || opts.animate === false) {
		write(`\n${render({})}\n\n`);
		return;
	}

	const sleep =
		opts.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
	const frames = Math.max(1, opts.frames ?? 28);
	const intervalMs = opts.intervalMs ?? 40;
	const plainLines = formatReadyBanner(opts.proxyUrl, opts.target, false).split(
		"\n",
	);
	const lineCount = plainLines.length;
	const width = plainLines[0]?.length ?? 0;
	const wipeFrames = Math.max(1, Math.round(frames * 0.45));
	const paint = (frame: string): string =>
		`${frame
			.split("\n")
			.map((line) => `\r${line}${CLEAR_EOL}`)
			.join("\n")}\n`;

	write(`\n${CURSOR_HIDE}`);
	try {
		for (let i = 0; i < frames; i++) {
			const reveal =
				i < wipeFrames
					? Math.ceil((width * (i + 1)) / wipeFrames)
					: Number.POSITIVE_INFINITY;
			// Negative phase so the colors appear to flow left to right.
			if (i > 0) write(`${CSI}${lineCount}A`);
			write(paint(render({ reveal, phase: (-i / frames) * 2 })));
			await sleep(intervalMs);
		}
		write(`${CSI}${lineCount}A`);
		write(paint(render({})));
	} finally {
		write(`${CURSOR_SHOW}\n`);
	}
}
