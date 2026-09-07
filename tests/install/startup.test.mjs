import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("test runners leave inherited installation storage untouched", { timeout: 120_000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "minions-install-storage-"));
  const liveHome = join(fixture, "user-state");
  mkdirSync(liveHome);
  const env = {
    ...process.env,
    MINIONS_HOME: liveHome,
    MINIONS_SERVER_DB: join(liveHome, "server.db"),
    DB_PATH: join(liveHome, "canvas.db"),
    MINIONS_ARTIFACTS_DIR: join(liveHome, "html"),
    MINIONS_E2E_HOME: join(fixture, "browser-home"),
  };
  // Child CLIs are standalone processes, not Node test-runner workers.
  delete env.NODE_TEST_CONTEXT;
  try {
    for (const file of [env.MINIONS_SERVER_DB, env.DB_PATH]) {
      const db = new Database(file);
      db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep me')");
      db.close();
    }
    const originalFiles = readdirSync(liveHome).sort();
    const originals = originalFiles.map((file) => readFileSync(join(liveHome, file)));
    const assertUntouched = () => {
      assert.deepEqual(readdirSync(liveHome).sort(), originalFiles);
      for (const [index, file] of originalFiles.entries()) {
        assert.deepEqual(readFileSync(join(liveHome, file)), originals[index], file);
      }
    };

    // Run the exact command-handler fixtures that used to persist leader-new/hi,
    // plus real storage probes in both the Node and DOM projects.
    const unitArgs = [
      "node_modules/vitest/vitest.mjs", "run",
      "server/commands/create-session.test.ts", "tests/contracts/test-storage.test.ts",
    ];
    await promisify(execFile)(process.execPath, unitArgs, {
      cwd: root, env, encoding: "utf8", timeout: 90_000,
    });
    assertUntouched();

    // A fresh installation must not gain a state directory from verification.
    const freshHome = join(fixture, "fresh-installation");
    await promisify(execFile)(process.execPath, unitArgs, {
      cwd: root, encoding: "utf8", timeout: 90_000,
      env: {
        ...env, MINIONS_HOME: freshHome,
        MINIONS_SERVER_DB: join(freshHome, "server.db"),
        DB_PATH: join(freshHome, "canvas.db"),
        MINIONS_ARTIFACTS_DIR: join(freshHome, "html"),
      },
    });
    assert.equal(existsSync(freshHome), false);

    // Use the browser server's actual environment without requiring Chromium.
    // Exercise both browser configs and production storage resolution.
    await promisify(execFile)(process.execPath, ["--import", "./scripts/register-typescript.mjs", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { createBrowserConfig } from './tests/e2e/browser-config.mjs';
      import { initDb } from './server/db.ts';
      import { openPersistDb, closePersistDb } from './server/session-persist.ts';
      import { getMinionsHome, registerWorkspace } from './server/workspace-registry.ts';
      import { writeHtmlArtifact } from './server/html-artifact-store.ts';
      const inheritedEnv = { ...process.env };
      for (const smoke of [true, false]) {
        Object.assign(process.env, inheritedEnv);
        Object.assign(process.env, createBrowserConfig({ smoke }).webServer.env);
        assert.equal(getMinionsHome(), path.join(process.env.MINIONS_E2E_HOME, '.minions'));
        const db = openPersistDb();
        db.prepare('INSERT OR REPLACE INTO sessions (session_key, task_name) VALUES (?, ?)').run('browser-probe', 'hi');
        closePersistDb();
        initDb().close();
        fs.mkdirSync(process.env.MINIONS_E2E_PROJECT, { recursive: true });
        registerWorkspace(process.env.MINIONS_E2E_PROJECT);
        await writeHtmlArtifact('browser-probe', { id: String(smoke), html: '<p>test</p>' });
      }
    `], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    assertUntouched();
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("startup launches both services from a checkout path with spaces without shell shims", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "minions startup spaces "));
  try {
    cpSync(join(root, "scripts"), join(fixture, "scripts"), { recursive: true });
    cpSync(join(root, "package.json"), join(fixture, "package.json"));
    mkdirSync(join(fixture, "dist"));
    // Stand-in CLIs exercise the real launchers without opening ports or a browser.
    // No .bin shims are installed, so these must run through Node directly.
    for (const name of ["tsx", "vite", "better-sqlite3"]) {
      const packageDir = join(fixture, "node_modules", name);
      mkdirSync(join(packageDir, "bin"), { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({
        name, type: "module", main: "index.js",
        exports: { ".": "./index.js", "./cli": "./index.js", "./package.json": "./package.json" },
      }));
      const cli = `
        import { writeFileSync, existsSync } from "node:fs";
        writeFileSync(${JSON.stringify(join(fixture, `${name}.json`))}, JSON.stringify(process.argv.slice(2)));
        const timer = setInterval(() => {
          if (existsSync(${JSON.stringify(join(fixture, "tsx.json"))}) &&
              existsSync(${JSON.stringify(join(fixture, "vite.json"))})) clearInterval(timer);
        }, 20);
        setTimeout(() => process.exit(1), 5000).unref();
      `;
      writeFileSync(join(packageDir, "index.js"), cli);
      writeFileSync(join(packageDir, "bin", "vite.js"), cli);
    }
    for (const command of ["dev", "preview", "start"]) {
      const result = spawnSync(process.execPath, scripts[command].split(" ").slice(1), {
        cwd: fixture, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, MINIONS_NO_OPEN: "1", HOST: "127.0.0.1", VITE_PORT: "6273" },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      if (command === "start") {
        const pid = Number(readFileSync(join(fixture, ".run", "minions.pid"), "utf8"));
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); } catch { break; }
          await delay(50);
        }
        assert.throws(() => process.kill(pid, 0), "background runner should finish");
      }
      assert.deepEqual(JSON.parse(readFileSync(join(fixture, "tsx.json"), "utf8")), ["server/index.ts"]);
      assert.deepEqual(JSON.parse(readFileSync(join(fixture, "vite.json"), "utf8")), [
        ...(command === "preview" ? ["preview"] : []),
        "--host", "127.0.0.1", "--port", "6273", "--strictPort",
      ]);
      rmSync(join(fixture, "tsx.json"));
      rmSync(join(fixture, "vite.json"));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

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
