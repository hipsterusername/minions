import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Playwright evaluates the config in both the runner and worker processes.
// Reuse the runner-created directory in workers so the test project remains
// inside the same HOME enforced by the server's path guard.
const e2eHome =
  process.env.MINIONS_E2E_HOME ??
  fs.mkdtempSync(path.join(os.tmpdir(), "minions-playwright-"));
const projectPath = path.join(e2eHome, "smoke-project");
process.env.MINIONS_E2E_HOME = e2eHome;
process.env.MINIONS_E2E_PROJECT = projectPath;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:6473",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node scripts/run.mjs dev",
    url: "http://127.0.0.1:6473",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: e2eHome,
      HOST: "127.0.0.1",
      PORT: "3473",
      VITE_PORT: "6473",
      MINIONS_TEST_HARNESS: "echo",
      MINIONS_NO_OPEN: "1",
      MINIONS_SERVER_DB: path.join(e2eHome, ".minions", "server.db"),
    },
  },
  globalTeardown: "./tests/e2e/global-teardown.mjs",
});
