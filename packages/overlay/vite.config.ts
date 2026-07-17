import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: () => "overlay.js" },
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: true,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
