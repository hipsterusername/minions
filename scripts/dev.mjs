#!/usr/bin/env node
import { spawn } from "child_process";

const isWin = process.platform === "win32";
const SERVER_RESTART_CODE = 42;

let shuttingDown = false;
let server = spawnServer();

const vite = spawn("npx", ["vite", "--open"], {
  stdio: "inherit",
  shell: isWin,
});

function spawnServer() {
  return spawn("npx", ["tsx", "server/index.ts"], {
    stdio: "inherit",
    shell: isWin,
  });
}

function cleanup() {
  shuttingDown = true;
  server.kill();
  vite.kill();
  process.exit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Restart just the backend when it requests a supervised restart. Other exits
// still bring the paired Vite process down.
function bindServerExit() {
  server.on("exit", (code) => {
    if (shuttingDown) return;
    if (code === SERVER_RESTART_CODE) {
      server = spawnServer();
      bindServerExit();
      return;
    }
    vite.kill();
    process.exit(code ?? 1);
  });
}

bindServerExit();

vite.on("exit", (code) => {
  shuttingDown = true;
  server.kill();
  process.exit(code ?? 1);
});
