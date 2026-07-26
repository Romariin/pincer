import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	diskOverlaySource,
	overlayBuildLines,
	overlayBuildMessage,
	staticOverlaySource,
} from "../src/overlaySource";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function distDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pincer-overlay-"));
	dirs.push(dir);
	return dir;
}

test("disk source re-reads the bundle after a rebuild", async () => {
	const dir = distDir();
	const path = join(dir, "overlay.js");
	await Bun.write(path, "first();");

	const source = diskOverlaySource(path);
	expect(await source.read()).toBe("first();");

	await Bun.write(path, "second();second();");
	expect(await source.read()).toBe("second();second();");
	source.close();
});

test("disk source notifies subscribers when the bundle changes", async () => {
	const dir = distDir();
	const path = join(dir, "overlay.js");
	await Bun.write(path, "first();");

	const source = diskOverlaySource(path);
	const changed = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no change event")), 5_000);
		source.onChange(() => {
			clearTimeout(timer);
			resolve();
		});
	});

	await Bun.write(path, "rebuilt();");
	await changed;
	expect(await source.read()).toBe("rebuilt();");
	source.close();
});

test("build output loses the escapes that would rewind the terminal", () => {
	const chunk =
		"[2Ktransforming...\rdist/overlay.js  11,000 kB\nbuilt in 620ms.\n";
	const lines = overlayBuildLines(chunk);
	expect(lines.some((line) => line.includes(""))).toBe(false);
	expect(lines.some((line) => line.includes("\r"))).toBe(false);
	expect(lines).toContain("built in 620ms.");
});

test("build output keeps failures and one line per rebuild", () => {
	expect(overlayBuildMessage("built in 620ms.")).toBe(
		"overlay rebuilt in 620ms",
	);
	expect(overlayBuildMessage("transforming...")).toBeNull();
	expect(overlayBuildMessage("✓ 3083 modules transformed.")).toBeNull();
	expect(overlayBuildMessage("watching for file changes...")).toBeNull();
	expect(overlayBuildMessage("dist/overlay.js  11,000 kB")).toBeNull();
	expect(overlayBuildMessage("error during build:")).toBe(
		"overlay build: error during build:",
	);
	// Context lines around an error carry no keyword; they must survive too.
	expect(
		overlayBuildMessage('"MONO" is not exported by src/lib/constants.ts'),
	).toBe('overlay build: "MONO" is not exported by src/lib/constants.ts');
});

test("static source never claims a path and never fires", async () => {
	const source = staticOverlaySource("baked();");
	expect(source.path).toBeNull();
	expect(await source.read()).toBe("baked();");
	let fired = false;
	source.onChange(() => {
		fired = true;
	});
	source.close();
	expect(fired).toBe(false);
});
