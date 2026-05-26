#!/usr/bin/env node

/**
 * Preflight check — validates that the host machine has everything
 * needed to run Minions before the user wastes time debugging.
 *
 * Run: pnpm preflight   (or:  node scripts/preflight.mjs)
 */

import { execSync } from "child_process";
import { existsSync } from "fs";

let ok = true;

function check(label, fn) {
  try {
    const result = fn();
    console.log(`  \x1b[32m✓\x1b[0m ${label}${result ? ` — ${result}` : ""}`);
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${label} — ${e.message}`);
    ok = false;
  }
}

console.log("\nMinions — preflight checks\n");

// ── Node.js ≥ 22 ──────────────────────────────────────
check("Node.js ≥ 22", () => {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 22) throw new Error(`found v${process.versions.node} — upgrade to ≥ 22`);
  return `v${process.versions.node}`;
});

// ── pnpm available ─────────────────────────────────────
check("pnpm installed", () => {
  const ver = execSync("pnpm --version", { encoding: "utf8" }).trim();
  return `v${ver}`;
});

// ── git available ──────────────────────────────────────
check("git installed", () => {
  const ver = execSync("git --version", { encoding: "utf8" }).trim();
  return ver;
});

// ── Claude Code executable override ─────────────────────
check("Claude Code executable resolution", () => {
  const configuredPath = process.env["CLAUDE_CODE_PATH"]?.trim();
  if (!configuredPath) {
    return "SDK default discovery (CLAUDE_CODE_PATH not set)";
  }
  if (!existsSync(configuredPath)) {
    throw new Error("CLAUDE_CODE_PATH points to a missing file");
  }
  return "CLAUDE_CODE_PATH set";
});

// ── Summary ────────────────────────────────────────────
console.log("");
if (ok) {
  console.log("  \x1b[32mAll checks passed.\x1b[0m Ready to run: pnpm start\n");
} else {
  console.log("  \x1b[31mSome checks failed.\x1b[0m Fix the issues above and re-run: pnpm preflight\n");
  process.exit(1);
}
