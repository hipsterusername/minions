import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Vitest configuration for the Minions canvas project.
 *
 * Uses two projects so the right environment runs against the right files:
 *
 *   • `node` — server, pure utility, contract, and architecture tests.
 *             Runs in the node environment with no DOM.
 *   • `dom`  — React component tests. Runs in jsdom with React Testing
 *             Library set up.
 */

const ROOT = path.resolve(import.meta.dirname);

export default defineConfig({
  test: {
    // Coverage is reported but not gated.
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts"],
      exclude: [
        "src/main.tsx",
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "tests/**",
      ],
    },
    projects: [
      {
        plugins: [],
        test: {
          name: "node",
          environment: "node",
          include: [
            "server/**/*.test.ts",
            "tests/architecture/**/*.test.ts",
            "tests/contracts/**/*.test.ts",
            "tests/harness/**/*.test.ts",
            "shared/**/*.test.ts",
            // Pure-function tests in src/ that don't need a DOM. They opt in
            // by using a `.node.test.ts` suffix or a top-of-file env hint.
            "src/**/*.node.test.ts",
            "src/**/!(*.dom).test.ts",
          ],
          // Tests in src/ that import .tsx component code are covered by the
          // dom project below.
          exclude: [
            "src/**/*.test.tsx",
            "src/**/*.dom.test.ts",
            "node_modules/**",
            "dist/**",
            ".canvas-worktrees/**",
          ],
        },
        resolve: {
          alias: {
            "@": path.resolve(ROOT, "src"),
            "@server": path.resolve(ROOT, "server"),
          },
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          environmentOptions: {
            jsdom: {
              url: "http://localhost/",
            },
          },
          setupFiles: ["./tests/setup-dom.ts"],
          include: [
            "src/**/*.test.tsx",
            "src/**/*.dom.test.ts",
          ],
          exclude: ["node_modules/**", "dist/**", ".canvas-worktrees/**"],
        },
        resolve: {
          alias: {
            "@": path.resolve(ROOT, "src"),
          },
        },
      },
    ],
  },
});
