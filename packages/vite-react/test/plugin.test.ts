/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { CONTRACT_A_VERSION } from "@pincer/core";
import pincer from "../src/index";

test("injects daemon and app identity without legacy shortcut configuration", () => {
	const daemonUrl = "ws://127.0.0.1:8123";
	const plugin = pincer({ daemonUrl });
	const hook = plugin.transformIndexHtml;
	if (typeof hook !== "function")
		throw new Error("expected transformIndexHtml hook");

	const result: unknown = Reflect.apply(hook, plugin, []);
	if (!Array.isArray(result)) throw new Error("expected injected tags");
	const configTag: unknown = result[0];
	if (
		typeof configTag !== "object" ||
		configTag === null ||
		!("children" in configTag) ||
		typeof configTag.children !== "string"
	) {
		throw new Error("expected injected config script");
	}
	const prefix = "window.__PINCER__=";
	if (!configTag.children.startsWith(prefix))
		throw new Error("expected Pincer config assignment");
	const injected: unknown = JSON.parse(configTag.children.slice(prefix.length));

	expect(injected).toEqual({
		wsUrl: daemonUrl,
		contractAVersion: CONTRACT_A_VERSION,
		projectRoot: process.cwd(),
	});
	expect(configTag.children).not.toContain("toggleKey");
});
