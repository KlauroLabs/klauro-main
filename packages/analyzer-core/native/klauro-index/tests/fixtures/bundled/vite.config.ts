import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "~utils": "/src/lib/utils",
      "react": path.resolve(__dirname, "./node_modules/react"),
    },
  },
});
