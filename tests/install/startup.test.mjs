import assert from "node:assert/strict";
import { execFile, spawnSync as spawnSyncProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { boundedLog } from "../../scripts/bounded-log.mjs";
import { supervise } from "../../scripts/launcher-supervisor.mjs";

// Fixture CLIs are standalone processes, not Node test-runner workers.
const fixtureEnv = { ...process.env };
delete fixtureEnv.NODE_TEST_CONTEXT;

// Fixture CLIs never read stdin. Avoid creating an unnecessary input pipe,
// which restricted process sandboxes may refuse even when the child succeeds.
function spawnSync(command, args, options = {}) {
  return spawnSyncProcess(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
}

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
        env: { ...fixtureEnv, MINIONS_NO_OPEN: "1", HOST: "127.0.0.1", VITE_PORT: "6273" },
      });
      assert.ifError(result.error);
      assert.equal(result.status, command === "start" ? 0 : 1, result.stderr);
      if (command === "start") {
        const pid = Number.parseInt(readFileSync(join(fixture, ".run", "minions.pid"), "utf8"), 10);
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
      rmSync(join(fixture, ".run"), { recursive: true, force: true });
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
      const result = spawnSync(process.execPath, args, { cwd: fixture, env: fixtureEnv, encoding: "utf8", timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, command);
      assert.match(result.stderr, /Run `pnpm install` first\./, command);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, command);
      assert.equal(existsSync(join(fixture, ".run")), false, command);
    }

    // An interrupted install can leave node_modules present but incomplete.
    mkdirSync(join(fixture, "node_modules"));
    const partial = spawnSync(process.execPath, ["scripts/start.mjs", "start"], {
      cwd: fixture, env: fixtureEnv, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /Run `pnpm install` first\./);

    for (const command of ["stop", "status"]) {
      const result = spawnSync(process.execPath, scripts[command].split(" ").slice(1), {
        cwd: fixture, env: fixtureEnv, encoding: "utf8", timeout: 10_000,
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
      cwd: root, env: fixtureEnv, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "42");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("second reconciled restart retains exit and spawn-error supervision", { timeout: 10_000 }, async () => {
  for (const ending of ["exit", "error"]) {
    let launches = 0;
    let reconciled = 0;
    const failure = await new Promise((resolve) => {
      supervise(() => {
        launches++;
        if (launches === 3 && ending === "error") return spawn(join(tmpdir(), "missing-minions-executable"), [], { stdio: "ignore", env: fixtureEnv });
        return spawn(process.execPath, ["-e", `process.exit(${launches < 3 ? 42 : 7})`], { stdio: "ignore", env: fixtureEnv });
      }, { stopped: () => false, reconcile: async () => { reconciled++; return true; }, fail: resolve });
    });
    assert.equal(launches, 3);
    assert.equal(reconciled, 2);
    assert.match(failure.message, ending === "error" ? /ENOENT/ : /exited \(7\)/);
  }
});

test("crash circuit has zero automatic retries even with a reconciliation capability", { timeout: 10_000 }, async () => {
  let launches = 0;
  let reconciled = 0;
  const error = await new Promise((resolve) => {
    supervise(() => {
      launches++;
      return spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore", env: fixtureEnv });
    }, { stopped: () => false, reconcile: async () => { reconciled++; return true; }, fail: resolve });
  });
  assert.equal(launches, 1);
  assert.equal(reconciled, 0);
  assert.match(error.message, /recovery refused/);
});

test("stop during restart reconciliation cannot launch another generation", { timeout: 10_000 }, async () => {
  let stopped = false;
  let launches = 0;
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  supervise(() => {
    launches++;
    return spawn(process.execPath, ["-e", "process.exit(42)"], { stdio: "ignore", env: fixtureEnv });
  }, {
    stopped: () => stopped,
    reconcile: () => { entered(); return new Promise((resolve) => { release = resolve; }); },
    fail: (error) => assert.fail(error),
  });
  await ready;
  stopped = true;
  release(true);
  await new Promise(setImmediate);
  assert.equal(launches, 1);
});

test("rotation closes old descriptors and retains only the bounded byte tail", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "minions-log-"));
  const path = join(fixture, "service.log");
  try {
    writeFileSync(path, Buffer.alloc(1000, 65));
    writeFileSync(`${path}.1`, Buffer.alloc(1000, 65));
    writeFileSync(`${path}.9`, Buffer.alloc(1000, 65));
    const writer = boundedLog(path, 32, 3);
    const child = spawn(process.execPath, ["-e", "process.stdout.write('0123456789'.repeat(10000))"], { stdio: ["ignore", "pipe", "ignore"], env: fixtureEnv });
    let bytes = 0;
    child.stdout.on("data", (chunk) => { bytes += chunk.length; writer.write(chunk); });
    await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(String(code)))); });
    writer.close();
    writer.close();
    assert.equal(bytes, 100000);
    assert.throws(() => writer.write("closed"), /closed/);
    assert.deepEqual(readdirSync(fixture).sort(), ["service.log", "service.log.1", "service.log.2"]);
    const retained = [2, 1, 0].map((index) => readFileSync(index ? `${path}.${index}` : path));
    assert.ok(retained.every((chunk) => chunk.length <= 32));
    assert.equal(Buffer.concat(retained).toString(), "0123456789".repeat(10000).slice(-96));
    const single = boundedLog(path, 8, 1);
    single.write("abcdefgh12345678"); single.close();
    assert.deepEqual(readdirSync(fixture), ["service.log"]);
    assert.equal(readFileSync(path, "utf8"), "12345678");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

function launcherFixture(backend, frontend) {
  const fixture = mkdtempSync(join(tmpdir(), "minions-lifecycle-"));
  cpSync(join(root, "scripts"), join(fixture, "scripts"), { recursive: true });
  for (const [name, code] of [["tsx", backend], ["vite", frontend], ["better-sqlite3", ""]]) {
    const dir = join(fixture, "node_modules", name);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", main: "index.js", exports: { ".": "./index.js", "./cli": "./index.js", "./package.json": "./package.json" } }));
    writeFileSync(join(dir, "index.js"), code);
    writeFileSync(join(dir, "bin", "vite.js"), code);
  }
  return fixture;
}

function runFixture(fixture) {
  const child = spawn(process.execPath, ["scripts/run.mjs"], { cwd: fixture, stdio: ["ignore", "pipe", "pipe"], env: { ...fixtureEnv, MINIONS_NO_OPEN: "1" } });
  let output = "";
  const waiters = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    output += chunk;
    for (const waiter of waiters) if (output.includes(waiter.text)) waiter.resolve();
  });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { child, closed, output: () => output, seen: (text) => output.includes(text) ? Promise.resolve() : Promise.race([new Promise((resolve) => waiters.push({ text, resolve })), closed.then(() => { throw new Error(`Launcher closed before ${text}: ${output}`); })]) };
}

test("intentional launcher stop permits a subsequent start without a recovery fence", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const code = 'console.log("fixture-ready"); setInterval(() => {}, 1000);';
  const fixture = launcherFixture(code, code);
  let run = runFixture(fixture);
  try {
    await run.seen("fixture-ready");
    run.child.kill("SIGTERM");
    assert.equal(await run.closed, 0);
    assert.ok(!existsSync(join(fixture, ".run", "recovery-required")));
    run = runFixture(fixture);
    await run.seen("fixture-ready");
    run.child.kill("SIGTERM");
    assert.equal(await run.closed, 0);
  } finally { run.child.kill("SIGKILL"); await run.closed; rmSync(fixture, { recursive: true, force: true }); }
});

test("partial startup failure stops the other service without blocking future starts", { timeout: 15_000 }, async () => {
  const fixture = launcherFixture('setInterval(() => {}, 1000);', 'throw new Error("frontend startup failed");');
  const run = runFixture(fixture);
  try {
    assert.equal(await run.closed, 1);
    assert.match(run.output(), /Frontend exited/);
    assert.match(run.output(), /automatic crash restart is disabled/);
    assert.ok(!existsSync(join(fixture, ".run", "recovery-required")));
  } finally { run.child.kill("SIGKILL"); await run.closed; rmSync(fixture, { recursive: true, force: true }); }
});

test("production runner supervises two explicit restarts then stops on a crash", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const fixture = launcherFixture(`
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const generation = existsSync("generation") ? Number(readFileSync("generation", "utf8")) + 1 : 1;
    writeFileSync("generation", String(generation));
    process.exit(generation < 3 ? 42 : 7);
  `, 'setInterval(() => {}, 1000);');
  const run = runFixture(fixture);
  try {
    assert.equal(await run.closed, 1);
    assert.equal(readFileSync(join(fixture, "generation"), "utf8"), "3");
    assert.match(run.output(), /exited \(7\)/);
  } finally { run.child.kill("SIGKILL"); await run.closed; rmSync(fixture, { recursive: true, force: true }); }
});

test("adopting oversized logs preserves the recent tail with a bounded copying buffer", () => {
  const fixture = mkdtempSync(join(tmpdir(), "minions-log-adopt-"));
  const path = join(fixture, "service.log");
  try {
    writeFileSync(path, "old history".repeat(10000) + "recent crash");
    const writer = boundedLog(path, 12, 2);
    writer.close();
    assert.equal(readFileSync(path, "utf8"), "recent crash");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("backend replacement stops owned provider descendants before the next launch", { timeout: 15_000, skip: process.platform !== "linux" }, async () => {
  const fixture = launcherFixture(`
    import { spawn } from "node:child_process";
    import { existsSync, readFileSync, appendFileSync } from "node:fs";
    const previous = existsSync("providers") ? readFileSync("providers", "utf8").trim().split("\\n").map(Number) : [];
    for (const pid of previous) {
      try {
        const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z") appendFileSync("overlap", String(pid));
      } catch {}
    }
    const provider = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    appendFileSync("providers", String(provider.pid) + "\\n");
    provider.once("message", () => process.exit(previous.length < 1 ? 42 : 7));
  `, 'setInterval(() => {}, 1000);');
  const run = runFixture(fixture);
  try {
    assert.equal(await run.closed, 1);
    assert.equal(readFileSync(join(fixture, "providers"), "utf8").trim().split("\n").length, 2);
    assert.ok(!existsSync(join(fixture, "overlap")), "old managed provider was still running at replacement");
  } finally { run.child.kill("SIGKILL"); await run.closed; rmSync(fixture, { recursive: true, force: true }); }
});
