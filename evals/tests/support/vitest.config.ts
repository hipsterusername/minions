import { defineConfig } from "vitest/config";

export default defineConfig({
  // Keep contract tests under tests/ while also running colocated library tests.
  // This package is intentionally independently runnable, so its test command
  // must not silently skip src/** coverage.
  test: { environment: "node", include: ["tests/**/*.test.ts", "src/**/*.test.ts"] }
});
