import { describe, expect, test } from "bun:test";
import { MIN_HOST_VISIBLE, PANEL_MAX_W, PANEL_MIN_W, PANEL_W } from "../src/lib/constants";
import { clampPanelWidth, fitPanelWidth } from "../src/lib/panelWidth";

describe("clampPanelWidth", () => {
	test("keeps a width inside the allowed range", () => {
		expect(clampPanelWidth(520)).toBe(520);
	});

	test("clamps below the minimum and above the maximum", () => {
		expect(clampPanelWidth(10)).toBe(PANEL_MIN_W);
		expect(clampPanelWidth(5000)).toBe(PANEL_MAX_W);
	});

	test("rounds fractional drag positions", () => {
		expect(clampPanelWidth(520.6)).toBe(521);
	});

	test("falls back to the default width for non-finite input", () => {
		expect(clampPanelWidth(Number.NaN)).toBe(PANEL_W);
	});
});

describe("fitPanelWidth", () => {
	test("keeps a sliver of the host page visible on a narrow viewport", () => {
		expect(fitPanelWidth(PANEL_MAX_W, 700)).toBe(700 - MIN_HOST_VISIBLE);
	});

	test("never shrinks below the minimum, however narrow the viewport", () => {
		expect(fitPanelWidth(PANEL_MAX_W, 200)).toBe(PANEL_MIN_W);
	});

	test("passes a fitting width through unchanged", () => {
		expect(fitPanelWidth(PANEL_W, 1440)).toBe(PANEL_W);
	});
});
