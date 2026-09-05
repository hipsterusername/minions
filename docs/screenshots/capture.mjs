import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "docs/images");
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  await fs.mkdir(output, { recursive: true });
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce" });
  await page.clock.setFixedTime(new Date("2026-09-05T12:00:00Z"));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // No real account, API, WebSocket, project state, or provider is contacted.
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = pathname === "/api/projects" ? [{
      id: "guide-project", name: "Minions Playground", path: "/home/you/projects/minions-playground",
      lastOpened: "2026-09-04T12:00:00Z", hasSidecar: false,
    }] : pathname === "/api/readiness" ? { ready: true, harnesses: [] }
      : pathname === "/api/auth/token" ? { token: "documentation-fixture" } : {};
    return route.fulfill({ json });
  });
  await page.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    return route.abort();
  });
  for (const scene of ["projects", "launch", "minions", "graph", "dashboard"]) {
    await page.goto(`${origin}/docs/screenshots/index.html?scene=${scene}`);
    await page.locator(scene === "projects" ? ".project-list-card" : scene === "graph" ? '[role="dialog"]' : ".guide-heading").first().waitFor();
    if (scene === "projects") {
      await page.getByPlaceholder("/path/to/existing/project...").fill("/home/you/projects/minions-playground");
      await page.getByText("Minions Playground", { exact: true }).waitFor();
    }
    if (scene === "launch") await page.getByText("Ready to launch", { exact: true }).waitFor();
    if (scene === "dashboard") await page.getByLabel("When no name is supplied", { exact: false }).waitFor();
    if (scene === "graph") await page.getByRole("button", { name: "Fit graph", exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, `getting-started-${scene}.png`), animations: "disabled" });
    if (scene === "graph") {
      await page.getByRole("button", { name: /Verify and summarize/ }).last().click();
      await page.getByText("Run default and named greeting checks, then summarize the changes for review.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Fit graph", exact: true }).click();
      await page.screenshot({ path: path.join(output, "getting-started-graph-detail.png"), animations: "disabled" });
    }
    console.log(`Captured ${scene}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser?.close();
  await server.close();
}
