#!/usr/bin/env node
import { spawn } from "child_process";

const isWin = process.platform === "win32";

const server = spawn("npx", ["tsx", "server/index.ts"], {
  stdio: "inherit",
  shell: isWin,
});

const vite = spawn("npx", ["vite", "--open"], {
  stdio: "inherit",
  shell: isWin,
});

function cleanup() {
  server.kill();
  vite.kill();
  process.exit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// If either process exits, kill the other and exit.
server.on("exit", (code) => {
  vite.kill();
  process.exit(code ?? 1);
});

vite.on("exit", (code) => {
  server.kill();
  process.exit(code ?? 1);
});
