#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDependencies } from "./check-dependencies.mjs";

checkDependencies(["tsx", "vite", "better-sqlite3"]);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "preview" ? "preview" : "dev";
const require = createRequire(import.meta.url);
const host = process.env["HOST"] || "127.0.0.1";
const vitePort = process.env["VITE_PORT"] || (mode === "preview" ? "4173" : "6173");
// Run JavaScript entry points directly: Windows .cmd shims need a shell,
// and shell command strings break executable and checkout paths with spaces.
const tsx = require.resolve("tsx/cli");
const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");

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
// A detached Windows runner has no console; hide the consoles its services
// would otherwise create and keep open for their entire lifetime.
const frontend = spawn(process.execPath, [vite, ...frontendArgs], { cwd: root, env, stdio: "inherit", shell: false, windowsHide: true });

function startServer() {
  return spawn(process.execPath, [tsx, "server/index.ts"], { cwd: root, env, stdio: "inherit", shell: false, windowsHide: true });
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
