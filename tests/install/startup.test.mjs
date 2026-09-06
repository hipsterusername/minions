import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("startup commands explain how to install dependencies in a clean checkout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "minions-install-"));
  try {
    cpSync(join(root, "scripts"), join(fixture, "scripts"), { recursive: true });
    cpSync(join(root, "package.json"), join(fixture, "package.json"));
    for (const command of ["start", "restart", "dev", "preview", "server", "preflight", "system-model:validate"]) {
      const [executable, ...args] = scripts[command].split(" ");
      assert.equal(executable, "node");
      const result = spawnSync(process.execPath, args, { cwd: fixture, encoding: "utf8", timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, command);
      assert.match(result.stderr, /Run `pnpm install` first\./, command);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, command);
      assert.equal(existsSync(join(fixture, ".run")), false, command);
    }

    // An interrupted install can leave node_modules present but incomplete.
    mkdirSync(join(fixture, "node_modules"));
    const partial = spawnSync(process.execPath, ["scripts/start.mjs", "start"], {
      cwd: fixture, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /Run `pnpm install` first\./);

    for (const command of ["stop", "status"]) {
      const result = spawnSync(process.execPath, scripts[command].split(" ").slice(1), {
        cwd: fixture, encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /pnpm install/);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the guarded preload still executes TypeScript when dependencies are installed", () => {
  const fixture = mkdtempSync(join(tmpdir(), "minions-typescript-"));
  try {
    const entry = join(fixture, "entry.ts");
    writeFileSync(entry, 'const value: number = 42; console.log(value);');
    const result = spawnSync(process.execPath, ["--import", "./scripts/register-typescript.mjs", entry], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "42");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
