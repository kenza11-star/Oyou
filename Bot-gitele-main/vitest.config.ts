import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { env: { GITHUB_FAST_COMMIT: "0" }, include: ["tests/**/*.test.ts"], environment: "node" },
});
