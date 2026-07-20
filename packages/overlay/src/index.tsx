import { createRoot } from "react-dom/client";
import overlayCss from "./overlay.css?inline";
import { RootProvider } from "./context/root";
import { App } from "./App";

function mount(): void {

  const host = document.createElement("div");
  host.id = "__pincer_root__";
  document.body.appendChild(host);
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
