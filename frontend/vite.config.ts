import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), preact()],
  resolve: {
    alias: {
      react: resolve("node_modules/preact/compat"),
      "react-dom": resolve("node_modules/preact/compat"),
      "react/jsx-runtime": resolve("node_modules/preact/jsx-runtime"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
