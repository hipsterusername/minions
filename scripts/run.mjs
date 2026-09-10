#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { checkDependencies } from "./check-dependencies.mjs";
import { boundedLog } from "./bounded-log.mjs";
import { supervise } from "./launcher-supervisor.mjs";

checkDependencies(["tsx", "vite", "better-sqlite3"]);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "preview" ? "preview" : "dev";
const require = createRequire(import.meta.url);
const host = process.env.HOST || "127.0.0.1";
const vitePort = process.env.VITE_PORT || (mode === "preview" ? "4173" : "6173");
const tsx = require.resolve("tsx/cli");
const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
if (mode === "preview" && !existsSync(join(root, "dist"))) {
  console.error("Built preview is unavailable: dist/ does not exist. Run `pnpm build` first.");
  process.exit(1);
}

const env = { ...process.env, HOST: host };
const logger = process.env.MINIONS_LAUNCH_LOG ? boundedLog(process.env.MINIONS_LAUNCH_LOG) : null;
const children = new Set();
const backendGroups = new Set();
let stopping = false;
let frontend;
function diagnostic(message) {
  try {
    if (logger) logger.write(`${message}\n`);
    else console.error(message);
  } catch { /* A disk error must not prevent shutdown. */ }
}
function signalBackend(pid, signal) {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else if (signal === "SIGTERM") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: 5_000,
      });
    } else process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function cleanupBackend(pid) {
  if (!backendGroups.has(pid)) return;
  signalBackend(pid, "SIGTERM");
  // Keep the runner alive until its owned provider process group is stopped.
  await delay(1_000);
  signalBackend(pid, "SIGKILL");
  backendGroups.delete(pid);
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  const deadline = setTimeout(() => process.exit(code || 1), 3_000);
  try {
    frontend?.kill("SIGTERM");
    await Promise.all([...backendGroups].map(cleanupBackend));
  } catch (error) {
    diagnostic(`Backend cleanup failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    for (const child of children) { try { child.kill("SIGKILL"); } catch {} }
    clearTimeout(deadline);
    process.exit(process.exitCode ?? code);
  }
}
function fail(error) {
  diagnostic(`Minions stopped after a service failure; automatic crash restart is disabled: ${error.message}`);
  void stop(1);
}
function launch(args, backend = false) {
  const child = spawn(process.execPath, args, {
    cwd: root, env, shell: false, windowsHide: true,
    detached: backend && process.platform !== "win32",
    stdio: logger ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  children.add(child);
  if (backend && child.pid) backendGroups.add(child.pid);
  child.once("exit", () => children.delete(child));
  child.once("error", () => children.delete(child));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", chunk => { try { logger.write(chunk); } catch (error) { fail(error); } });
    stream?.on("error", fail);
  }
  return child;
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("exit", () => { try { logger?.close(); } catch {} });

supervise(() => launch([tsx, "server/index.ts"], true), {
  stopped: () => stopping,
  reconcile: async child => {
    if (mode !== "dev") return false;
    // Windows cannot target a departed process tree. Explicit pnpm restart
    // stops the live runner tree first; never guess at descendants after exit.
    if (process.platform === "win32") return false;
    await cleanupBackend(child.pid);
    return true;
  },
  fail,
});
if (!stopping) {
  const args = mode === "preview"
    ? ["preview", "--host", host, "--port", vitePort, "--strictPort"]
    : ["--host", host, "--port", vitePort, "--strictPort", ...(process.env.MINIONS_NO_OPEN === "1" ? [] : ["--open"])];
  frontend = launch([vite, ...args]);
  frontend.once("error", fail);
  frontend.once("exit", code => { if (!stopping) fail(new Error(`Frontend exited (${code})`)); });
}
