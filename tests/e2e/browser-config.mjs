import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

export function createBrowserConfig({ smoke = false } = {}) {
  // Playwright evaluates the config in both the runner and worker processes.
  // Reuse the runner-created directory in workers so the test project remains
  // inside the same HOME enforced by the server's path guard.
  const e2eHome =
    process.env.MINIONS_E2E_HOME ??
    fs.mkdtempSync(path.join(os.tmpdir(), "minions-playwright-"));
  const projectPath = path.join(e2eHome, "smoke-project");
  const serverDb = path.join(e2eHome, ".minions", "server.db");
  const fakePiPath = path.resolve("tests/e2e/task-graph-fixtures/fake-pi.mjs");
  process.env.MINIONS_E2E_HOME = e2eHome;
  process.env.MINIONS_E2E_PROJECT = projectPath;
  process.env.MINIONS_E2E_DB = serverDb;

  return defineConfig({
    ...(smoke
      ? { testMatch: "**/clean-clone.smoke.spec.mjs" }
      : { testIgnore: "**/clean-clone.smoke.spec.mjs" }),
    testDir: "./tests/e2e",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
    use: {
      baseURL: "http://127.0.0.1:6473",
      actionTimeout: 10_000,
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
    webServer: {
      command: "node scripts/run.mjs dev",
      // Wait through Vite's proxy for the backend as well as the frontend.
      // Vite can accept requests before the API server is listening, which
      // otherwise lets the first test race the auth bootstrap endpoint.
      url: "http://127.0.0.1:6473/api/auth/token",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: e2eHome,
        HOST: "127.0.0.1",
        PORT: "3473",
        VITE_PORT: "6473",
        MINIONS_TEST_HARNESS: "echo",
        // Explicit missing binaries prevent local provider installs or inherited
        // credentials from changing these deterministic fixture defaults.
        CLAUDE_CODE_PATH: path.join(e2eHome, "unavailable-harness"),
        CODEX_PATH: path.join(e2eHome, "unavailable-harness"),
        OPENCODE_PATH: path.join(e2eHome, "unavailable-harness"),
        PI_PATH: smoke ? path.join(e2eHome, "unavailable-harness") : fakePiPath,
        MINIONS_NO_OPEN: "1",
        MINIONS_HOME: path.join(e2eHome, ".minions"),
        MINIONS_SERVER_DB: serverDb,
        DB_PATH: path.join(e2eHome, ".minions", "canvas.db"),
        MINIONS_ARTIFACTS_DIR: path.join(e2eHome, ".minions", "artifacts", "html"),
      },
    },
    globalTeardown: "./tests/e2e/global-teardown.mjs",
  });
}
