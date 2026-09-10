#!/usr/bin/env node
// Launches Minions (server + vite) detached in the background and returns to
// the terminal. Logs are redirected to a file rather than streamed inline.
//   pnpm start          start in background
//   pnpm start stop     stop the background service
//   pnpm start restart  restart the background service
//   pnpm start status   report whether it is running
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDependencies } from "./check-dependencies.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, "..");
const runDir = join(root, ".run");
const logFile = join(runDir, "minions.log");
const pidFile = join(runDir, "minions.pid");
const tailscaleFile = join(runDir, "tailscale.enabled");
const isWin = process.platform === "win32";
const vitePort = process.env["VITE_PORT"] ?? "6173";

const action = process.argv[2] ?? "start";
const tailscale = process.argv.includes("--tailscale");

switch (action) {
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  case "restart":
    restart();
    break;
  case "start":
    start();
    break;
  default:
    console.error(`Unknown action "${action}". Use start, stop, restart, or status.`);
    process.exit(1);
}

function readPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  return Number.isInteger(pid) ? pid : null;
}

function isRunning(pid) {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still running.
    return err.code === "EPERM";
  }
}

function rel(p) {
  return relative(process.cwd(), p) || p;
}

function start(enableTail = tailscale) {
  const existing = readPid();
  if (isRunning(existing)) {
    console.log(`Minions is already running (pid ${existing}).`);
    if (enableTail) {
      enableTailscaleServe();
      mkdirSync(runDir, { recursive: true });
      writeFileSync(tailscaleFile, vitePort);
    }
    console.log(`  logs: ${rel(logFile)}`);
    console.log(`  stop: pnpm stop`);
    return;
  }

  checkDependencies(["tsx", "vite", "better-sqlite3"]);
  mkdirSync(runDir, { recursive: true });
  const child = spawn(process.execPath, [join(scriptDir, "run.mjs"), "dev"], {
    cwd: root,
    detached: true,
    // The runner owns rotation; inherited append descriptors bypass its bound.
    stdio: "ignore",
    env: { ...process.env, MINIONS_LAUNCH_LOG: logFile },
    shell: false,
    windowsHide: true,
  });

  writeFileSync(pidFile, String(child.pid));
  // Detach from the parent's event loop so the terminal returns immediately.
  child.unref();

  if (enableTail) {
    try {
      enableTailscaleServe();
    } catch {
      try { process.kill(isWin ? child.pid : -child.pid, "SIGTERM"); } catch {}
      if (existsSync(pidFile)) rmSync(pidFile);
      process.exit(1);
    }
    writeFileSync(tailscaleFile, vitePort);
  }

  console.log(`Minions started in background (pid ${child.pid}).`);
  console.log(`  logs:   ${rel(logFile)}`);
  console.log(`  status: pnpm status`);
  console.log(`  stop:   pnpm stop`);
}

function stop() {
  const pid = readPid();
  if (!isRunning(pid)) {
    console.log("Minions is not running.");
    if (existsSync(pidFile)) rmSync(pidFile);
    if (existsSync(tailscaleFile)) {
      disableTailscaleServe();
      rmSync(tailscaleFile, { force: true });
    }
    return;
  }

  try {
    if (isWin) {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: 5_000,
      });
      if (result.error || result.status !== 0) throw result.error ?? new Error("Could not stop the launcher tree");
    } else {
      // The detached child is a process-group leader; signal the whole group
      // so the server and vite children go down with it.
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have exited between the group and individual signals.
    }
  }

  const deadline = Date.now() + 5_000;
  while (isRunning(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (isRunning(pid)) {
    throw new Error(`Minions (pid ${pid}) did not stop; preserving its ownership record.`);
  }
  if (existsSync(pidFile)) rmSync(pidFile);
  if (existsSync(tailscaleFile)) {
    disableTailscaleServe();
    rmSync(tailscaleFile, { force: true });
  }
  console.log(`Minions stopped (pid ${pid}).`);
}

function restart() {
  checkDependencies(["tsx", "vite", "better-sqlite3"]);
  const restoreTailscale = tailscale || existsSync(tailscaleFile);
  const pid = readPid();
  if (isRunning(pid)) {
    stop();
    const deadline = Date.now() + 3000;
    while (isRunning(pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  } else if (existsSync(pidFile)) {
    rmSync(pidFile);
  }
  start(restoreTailscale);
}

function status() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`Minions is running (pid ${pid}).`);
    console.log(`  logs: ${rel(logFile)}`);
    if (existsSync(tailscaleFile)) showTailscaleServeStatus();
  } else {
    console.log("Minions is not running.");
  }
}

function runTailscaleServe(args, stdio = "inherit") {
  return spawnSync(process.execPath, [join(scriptDir, "tailscale-serve.mjs"), ...args], {
    cwd: root,
    stdio,
    shell: false,
    windowsHide: true,
  });
}

function enableTailscaleServe() {
  const result = runTailscaleServe(["--port", vitePort]);
  if (result.status !== 0) {
    console.error("\nMinions was not started because Tailscale HTTPS serving could not be configured.");
    throw new Error("Tailscale configuration failed");
  }
}

function disableTailscaleServe() {
  const result = runTailscaleServe(["--port", vitePort, "--off"]);
  if (result.status !== 0) {
    console.error("Warning: failed to tear down Tailscale serve config.");
  }
}

function showTailscaleServeStatus() {
  runTailscaleServe(["--status"]);
}
