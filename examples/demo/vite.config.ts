import pincer from "@pincer/vite-react";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// pincer() tags host JSX elements (Contract A) via an enforce:"pre" transform
// that runs before @vitejs/plugin-react, and injects/serves the overlay.
export default defineConfig({
	plugins: [react(), pincer()],
});
