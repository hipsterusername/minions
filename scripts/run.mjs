#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "preview" ? "preview" : "dev";
const isWin = process.platform === "win32";
const host = process.env["HOST"] || "127.0.0.1";
const vitePort = process.env["VITE_PORT"] || (mode === "preview" ? "4173" : "6173");
const binExt = isWin ? ".cmd" : "";
const tsx = join(root, "node_modules", ".bin", `tsx${binExt}`);
const vite = join(root, "node_modules", ".bin", `vite${binExt}`);

if (mode === "preview" && !existsSync(join(root, "dist"))) {
  console.error("Built preview is unavailable: dist/ does not exist. Run `pnpm build` first.");
  process.exit(1);
}
if (!existsSync(tsx) || !existsSync(vite)) {
  console.error("Local development binaries are missing. Run `pnpm install` first.");
  process.exit(1);
}

const env = { ...process.env, HOST: host };
let stopping = false;
let server = startServer();
const frontendArgs = mode === "preview"
  ? ["preview", "--host", host, "--port", vitePort, "--strictPort"]
  : [
      "--host",
      host,
      "--port",
      vitePort,
      "--strictPort",
      ...(process.env["MINIONS_NO_OPEN"] === "1" ? [] : ["--open"]),
    ];
const frontend = spawn(vite, frontendArgs, { cwd: root, env, stdio: "inherit", shell: false });

function startServer() {
  return spawn(tsx, ["server/index.ts"], { cwd: root, env, stdio: "inherit", shell: false });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM");
  frontend.kill("SIGTERM");
  process.exitCode = code;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

server.on("exit", (code) => {
  if (stopping) return;
  if (code === 42 && mode === "dev") {
    server = startServer();
    return;
  }
  stop(code ?? 1);
});
frontend.on("exit", (code) => stop(code ?? 1));
