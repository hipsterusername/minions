#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../server/harness/register-production.ts";
import { getHarnessReadiness } from "../server/harness/readiness.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let hostOk = true;

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { shell: false, encoding: "utf8", timeout: 5_000, maxBuffer: 16_384 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function check(label, fn) {
  try {
    const detail = await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    console.log(`  \x1b[31m✗\x1b[0m ${label} — ${error instanceof Error ? error.message : String(error)}`);
    hostOk = false;
  }
}

function canBind(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(`127.0.0.1:${port}`)));
  });
}

console.log("\nMinions — host checks\n");
await check("Node.js ≥ 22", async () => {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major < 22) throw new Error(`found v${process.versions.node}; upgrade to Node 22 or newer`);
  return `v${process.versions.node}`;
});
await check("declared pnpm", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expected = String(pkg.packageManager).replace(/^pnpm@/, "").split("+")[0];
  const lifecycleVersion = process.env["npm_config_user_agent"]?.match(/^pnpm\/([^ ]+)/)?.[1];
  const actual = lifecycleVersion ?? await run("pnpm", ["--version"]);
  if (actual !== expected) throw new Error(`found v${actual}; repository declares v${expected}`);
  return `v${actual}`;
});
await check("git", async () => run("git", ["--version"]));
await check("backend port", async () => canBind(Number(process.env["PORT"] ?? 3141)));
await check("frontend port", async () => canBind(Number(process.env["VITE_PORT"] ?? 6173)));
await check("native dependencies", async () => {
  await import("better-sqlite3");
  return "better-sqlite3 loaded";
});

console.log("\nHarness readiness\n");
const snapshot = await getHarnessReadiness({ fresh: true });
for (const harness of snapshot.harnesses) {
  const mark = harness.ready ? "\x1b[32m✓\x1b[0m" : "\x1b[33m!\x1b[0m";
  console.log(`  ${mark} ${harness.name} — ${harness.state}`);
  if (!harness.ready && harness.remediation) {
    console.log(`      ${harness.remediation.label}${harness.remediation.command ? `: ${harness.remediation.command}` : ""}`);
  }
}

console.log("");
if (hostOk && snapshot.ready) {
  console.log("  \x1b[32mAll required checks passed.\x1b[0m Ready to run: pnpm start\n");
} else {
  console.log("  \x1b[31mPreflight failed.\x1b[0m Fix the issues above and re-run: pnpm preflight\n");
  process.exitCode = 1;
}
