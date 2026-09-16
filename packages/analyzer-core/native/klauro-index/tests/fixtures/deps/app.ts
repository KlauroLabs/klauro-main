import { describe } from "vitest";
import { defineConfig } from "vite";
import { createRoot } from "react-dom/client";

export function mount(): void {
  describe("x", () => defineConfig({}));
  createRoot(document.body);
}
