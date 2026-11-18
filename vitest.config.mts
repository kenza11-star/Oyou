import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { env: { GITHUB_FAST_COMMIT: "0" }, include: ["tests/**/*.test.{ts,tsx}"], environment: "node" },
});
