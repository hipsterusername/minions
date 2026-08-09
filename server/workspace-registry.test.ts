import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findWorkspaceBySource,
  registerWorkspace,
  resolveWorkspace,
} from "./workspace-registry.ts";

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
});
