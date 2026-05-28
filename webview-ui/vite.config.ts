import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Emit a single JS bundle so the VS Code extension's webview loader (which
    // picks one .js and one .css from /assets) keeps working unchanged.
    rollupOptions: {
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
});