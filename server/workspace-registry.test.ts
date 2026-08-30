import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  attachWorkspace,
  findWorkspaceBySource,
  rebindWorkspace,
  registerWorkspace,
  resolveWorkspace,
  updateWorkspaceNickname,
  workspaceStateRoot,
} from "./workspace-registry.ts";
import { initDb } from "./db.ts";

let minionsHome: string;
let sourceRoot: string;

beforeEach(() => {
  minionsHome = fs.mkdtempSync(path.join(os.tmpdir(), "minions-home-registry-"));
  sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mounted-source-"));
  vi.stubEnv("MINIONS_HOME", minionsHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(minionsHome, { recursive: true, force: true });
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

describe("workspace registry", () => {
  it("persists a stable UUID and resolves source and central state roots", () => {
    const first = registerWorkspace(sourceRoot)!;
    const second = registerWorkspace(sourceRoot)!;

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.id).toBe(first.id);
    expect(first.sourceRoot).toBe(fs.realpathSync(sourceRoot));
    expect(first.stateRoot).toBe(path.join(minionsHome, "workspaces", first.id));
    expect(fs.existsSync(first.stateRoot)).toBe(true);
    expect(resolveWorkspace(first.id)).toEqual(first);
    expect(findWorkspaceBySource(sourceRoot)).toEqual(first);
  });

  it("canonicalizes a mounted source alias and rejects UUID/source mismatches", () => {
    const alias = path.join(path.dirname(sourceRoot), `${path.basename(sourceRoot)}-alias`);
    fs.symlinkSync(sourceRoot, alias, "junction");
    const workspace = registerWorkspace(alias)!;
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "other-source-"));

    expect(workspace.sourceRoot).toBe(fs.realpathSync(sourceRoot));
    expect(resolveWorkspace(workspace.id, sourceRoot)).toEqual(workspace);
    expect(resolveWorkspace(workspace.id, other)).toBeNull();

    fs.rmSync(alias, { force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("copies a legacy sidecar without modifying it or importing symlinks", () => {
    const legacy = path.join(sourceRoot, ".minions");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "context.md"), "legacy context");
    const outside = path.join(sourceRoot, "outside.txt");
    fs.writeFileSync(outside, "do not import");
    fs.symlinkSync(outside, path.join(legacy, "linked.txt"));

    const workspace = registerWorkspace(sourceRoot)!;

    expect(fs.readFileSync(path.join(workspace.stateRoot, "context.md"), "utf8"))
      .toBe("legacy context");
    expect(fs.readFileSync(path.join(legacy, "context.md"), "utf8")).toBe("legacy context");
    expect(fs.existsSync(path.join(workspace.stateRoot, "linked.txt"))).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("preserves an unambiguous legacy project UUID during migration", () => {
    const legacyRoot = path.join(sourceRoot, ".minions");
    fs.mkdirSync(legacyRoot);
    const legacyId = "22222222-2222-4222-8222-222222222222";
    const db = initDb(path.join(legacyRoot, "canvas.db"));
    db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(legacyId, "Legacy");
    db.close();

    const workspace = registerWorkspace(sourceRoot)!;

    expect(workspace.id).toBe(legacyId);
    expect(fs.existsSync(path.join(workspace.stateRoot, "canvas.db"))).toBe(true);
    expect(fs.existsSync(path.join(legacyRoot, "canvas.db"))).toBe(true);
  });

  it("rebinds a moved repository without changing its UUID, nickname, or state root", () => {
    const workspace = registerWorkspace(sourceRoot, { nickname: "Portable" })!;
    fs.writeFileSync(path.join(workspace.stateRoot, "marker.txt"), "durable");
    const movedRoot = `${sourceRoot}-moved`;
    fs.renameSync(sourceRoot, movedRoot);
    sourceRoot = movedRoot;

    const rebound = rebindWorkspace(workspace.id, movedRoot)!;

    expect(rebound).toMatchObject({ id: workspace.id, nickname: "Portable",
      sourceRoot: fs.realpathSync(movedRoot), stateRoot: workspace.stateRoot });
    expect(fs.readFileSync(path.join(rebound.stateRoot, "marker.txt"), "utf8")).toBe("durable");
  });

  it("gives a copied repository a new UUID unless explicitly attached", () => {
    const original = registerWorkspace(sourceRoot, { nickname: "Original" })!;
    fs.writeFileSync(path.join(original.stateRoot, "marker.txt"), "original state");
    const copiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copied-source-"));
    try {
      const copied = registerWorkspace(copiedRoot)!;
      expect(copied.id).not.toBe(original.id);

      const attached = attachWorkspace(original.id, copiedRoot)!;
      expect(attached.id).toBe(original.id);
      expect(attached.sourceRoot).toBe(fs.realpathSync(copiedRoot));
      expect(resolveWorkspace(copied.id)).toBeNull();
      expect(fs.existsSync(copied.stateRoot)).toBe(true);
      expect(fs.readFileSync(path.join(attached.stateRoot, "marker.txt"), "utf8"))
        .toBe("original state");
    } finally {
      fs.rmSync(copiedRoot, { recursive: true, force: true });
    }
  });

  it("persists an editable registry nickname", () => {
    const workspace = registerWorkspace(sourceRoot)!;
    expect(updateWorkspaceNickname(workspace.id, "Renamed")?.nickname).toBe("Renamed");
    expect(resolveWorkspace(workspace.id)?.nickname).toBe("Renamed");
  });

  it("derives Windows state paths with Windows separators", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(workspaceStateRoot("C:\\workspace\\.minions", id, path.win32))
      .toBe(`C:\\workspace\\.minions\\workspaces\\${id}`);
  });

  it("fails closed when a workspace state root is replaced by a symlink", () => {
    const workspace = registerWorkspace(sourceRoot)!;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-state-"));
    fs.rmSync(workspace.stateRoot, { recursive: true });
    fs.symlinkSync(outside, workspace.stateRoot, "junction");

    expect(resolveWorkspace(workspace.id)).toBeNull();
    expect(findWorkspaceBySource(sourceRoot)).toBeNull();

    fs.rmSync(workspace.stateRoot, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("does not overwrite a malformed registry during registration", () => {
    const registry = path.join(minionsHome, "workspaces", "registry.json");
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    const malformed = "{ definitely not registry json";
    fs.writeFileSync(registry, malformed, { mode: 0o600 });

    expect(() => registerWorkspace(sourceRoot)).toThrow(/unreadable or malformed/);
    expect(fs.readFileSync(registry, "utf8")).toBe(malformed);
  });

  it("preserves every binding across concurrent registration requests", async () => {
    const sources = Array.from({ length: 8 }, () =>
      fs.mkdtempSync(path.join(os.tmpdir(), "concurrent-source-")));
    try {
      const moduleUrl = new URL("./workspace-registry.ts", import.meta.url).href;
      const program = [
        `import { registerWorkspace } from ${JSON.stringify(moduleUrl)};`,
        "if (!registerWorkspace(process.argv[1])) process.exit(2);",
      ].join("\n");
      await Promise.all(sources.map((source) => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--eval", program, source], {
          env: { ...process.env, MINIONS_HOME: minionsHome },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => code === 0
          ? resolve()
          : reject(new Error(`registration process exited ${code}: ${stderr}`)));
      })));
      const bindings = sources.map((source) => findWorkspaceBySource(source)!);

      expect(new Set(bindings.map((row) => row.id)).size).toBe(sources.length);
      for (const binding of bindings) {
        expect(resolveWorkspace(binding.id)).toEqual(binding);
      }
    } finally {
      for (const source of sources) fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("recovers a registry lock left by a crashed process", () => {
    const lock = path.join(minionsHome, "workspaces", ".registry.lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
      token: "abandoned",
      pid: 2_147_483_647,
      createdAt: Date.now() - 60_000,
    }));

    expect(registerWorkspace(sourceRoot)).not.toBeNull();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("rejects a symlinked central workspaces root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-workspaces-"));
    fs.symlinkSync(outside, path.join(minionsHome, "workspaces"), "junction");
    try {
      expect(() => registerWorkspace(sourceRoot)).toThrow(/real directory/);
    } finally {
      fs.rmSync(path.join(minionsHome, "workspaces"), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
