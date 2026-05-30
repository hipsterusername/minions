#!/usr/bin/env node

/**
 * check-licenses — fail the build if any installed package carries a license
 * outside the allowlist below.
 *
 * Runs as part of `pnpm verify`. Walks every `package.json` under
 * `node_modules/` (pnpm content-addressed store *and* hoisted view), reads
 * the `license` / `licenses` field, and reports anything unknown.
 *
 * The allowlist is intentionally permissive (MIT, BSD, Apache-2.0, ISC,
 * 0BSD, CC0-1.0, Unlicense, Python-2.0, BlueOak-1.0.0). Anything copyleft
 * (GPL, LGPL, AGPL, MPL, EPL, CDDL) or source-available (SSPL, BUSL,
 * Commons Clause, Elastic) trips the gate.
 *
 * To allow an exception: add the package name (not the license) to
 * `EXCEPTIONS` below with a one-line justification.
 *
 * Run: pnpm check:licenses
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set([
  "MIT",
  "MIT-0", // MIT No Attribution — strictly more permissive than MIT.
  "ISC",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-3-Clause-Clear",
  "0BSD",
  "Apache-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "Python-2.0",
  "BlueOak-1.0.0",
  "WTFPL",
  "Zlib",
]);

// Per-package exceptions. Each entry MUST carry a justification comment.
// MPL-2.0 is intentionally NOT on the global allowlist: it's weak file-level
// copyleft, so per-package review is appropriate. Consumers (no source mods)
// are unaffected; modifying an MPL-2.0 file requires sharing that file's
// changes under MPL-2.0.
const EXCEPTIONS = new Map([
  [
    "@anthropic-ai/claude-agent-sdk",
    "SDK license is 'SEE LICENSE IN README.md' (SPDX punt by Anthropic). Terms permit commercial use of our generated code.",
  ],
  [
    "@anthropic-ai/claude-agent-sdk-win32-x64",
    "Platform-specific binary of @anthropic-ai/claude-agent-sdk. Same license posture.",
  ],
  [
    "@anthropic-ai/claude-agent-sdk-linux-x64",
    "Platform-specific binary of @anthropic-ai/claude-agent-sdk for Linux glibc. Same license posture.",
  ],
  [
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    "Platform-specific binary of @anthropic-ai/claude-agent-sdk for Linux musl. Same license posture.",
  ],
  [
    "lightningcss",
    "MPL-2.0 (weak file-level copyleft). Consumed unmodified as a build-time CSS transform via Vite — no source obligation unless we modify lightningcss source files.",
  ],
  [
    "lightningcss-win32-x64-msvc",
    "Platform-specific native binary of lightningcss. Same MPL-2.0 posture; consumed unmodified.",
  ],
  [
    "lightningcss-linux-x64-gnu",
    "Platform-specific native binary of lightningcss for Linux glibc. Same MPL-2.0 posture; consumed unmodified.",
  ],
  [
    "lightningcss-linux-x64-musl",
    "Platform-specific native binary of lightningcss for Linux musl. Same MPL-2.0 posture; consumed unmodified.",
  ],
]);

const root = process.cwd();
const errors = [];
const seen = new Set();

function normalizeLicense(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? v : v?.type ?? "")).join(" OR ");
  }
  if (typeof value === "object" && value.type) return value.type;
  return null;
}

function isAllowed(spec) {
  if (!spec) return false;
  // Allow simple SPDX expressions: "MIT", "(MIT OR Apache-2.0)", "MIT AND BSD-3-Clause".
  const tokens = spec
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => ALLOWED.has(t));
}

function* walkPackageJsons(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === ".bin" || name === ".cache" || name === ".pnpm-state") continue;
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    // Scoped packages: recurse one level.
    if (name.startsWith("@")) {
      yield* walkPackageJsons(full);
      continue;
    }
    const pkgPath = join(full, "package.json");
    try {
      statSync(pkgPath);
      yield pkgPath;
    } catch {
      // No package.json here; could be a nested store. Recurse cautiously.
      if (name === "node_modules") yield* walkPackageJsons(full);
    }
  }
}

function checkTree(rootNodeModules) {
  for (const pkgPath of walkPackageJsons(rootNodeModules)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (EXCEPTIONS.has(pkg.name)) continue;
    const license = normalizeLicense(pkg.license ?? pkg.licenses);
    if (!isAllowed(license)) {
      errors.push({ id, license: license ?? "(missing)", path: pkgPath });
    }
  }
}

// Scan the hoisted view first, then the pnpm content-addressed store.
checkTree(join(root, "node_modules"));
checkTree(join(root, "node_modules", ".pnpm"));

if (errors.length > 0) {
  console.error(`\n✗ check-licenses: ${errors.length} package(s) outside allowlist:\n`);
  for (const e of errors) {
    console.error(`  ${e.id}  →  ${e.license}`);
    console.error(`    ${e.path}`);
  }
  console.error(
    `\nIf this is intentional, add an entry to EXCEPTIONS in scripts/check-licenses.mjs`,
  );
  console.error(`with a justification comment. Otherwise, remove the offending dependency.\n`);
  process.exit(1);
}

console.log(`✓ check-licenses: ${seen.size} packages, all licenses on allowlist`);
