import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RootProvider } from "./context/root";
import { followSystemScheme } from "./lib/colorScheme";
import overlayCss from "./overlay.css?inline";

function mount(): void {
	const host = document.createElement("div");
	host.id = "__pincer_root__";
	// Sibling of <body>, not a child of it: the open panel transforms <body> to pull
	// the host page fully aside, and a transformed ancestor would capture our own
	// fixed positioning (see components/Panel.tsx).
	document.documentElement.appendChild(host);
	const shadow = host.attachShadow({ mode: "open" });

	// Tailwind v4 emits @property rules; shadow roots ignore @property, so hoist a
	// copy to document.head. (@property bodies have no nested braces; the regex is
	// safe. This hoist and the panel margin-push are the only intentional host
	// writes; the hoist is inert.)
	const props = overlayCss.match(/@property\s+[^{]+\{[^}]*\}/g) ?? [];
	if (props.length && !document.getElementById("__pincer_props__")) {
		const s = document.createElement("style");
		s.id = "__pincer_props__";
		s.textContent = props.join("\n");
		document.head.appendChild(s);
	}

	const style = document.createElement("style");
	style.textContent = overlayCss;
	shadow.appendChild(style);

	const mountNode = document.createElement("div");
	shadow.appendChild(mountNode);
	followSystemScheme(mountNode);

	createRoot(mountNode).render(
		<RootProvider shadowRoot={shadow} host={host}>
			<App />
		</RootProvider>,
	);

	console.info("[pincer] overlay ready");
}

if (!window.__PINCER_LOADED__) {
	window.__PINCER_LOADED__ = true;
	mount();
}
