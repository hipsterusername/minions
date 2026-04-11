#!/usr/bin/env node

/**
 * Preflight check — validates that the host machine has everything
 * needed to run Minions before the user wastes time debugging.
 *
 * Run: pnpm preflight   (or:  node scripts/preflight.mjs)
 */

import { execSync } from "child_process";

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

// ── Claude Code CLI ────────────────────────────────────
check("Claude Code CLI (claude)", () => {
  try {
    const ver = execSync("claude --version 2>/dev/null", { encoding: "utf8" }).trim();
    return ver;
  } catch {
    throw new Error(
      "not found — install Claude Code: https://docs.anthropic.com/en/docs/claude-code"
    );
  }
});

// ── Summary ────────────────────────────────────────────
console.log("");
if (ok) {
  console.log("  \x1b[32mAll checks passed.\x1b[0m Ready to run: pnpm start\n");
} else {
  console.log("  \x1b[31mSome checks failed.\x1b[0m Fix the issues above and re-run: pnpm preflight\n");
  process.exit(1);
}
