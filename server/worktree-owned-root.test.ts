import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerWorkspace } from "./workspace-registry.ts";
import {
  allowedWorktreeRoots,
  isOwnedWorktreePath,
  ownedWorktreeRoot,
} from "./worktree-owned-root.ts";

let minionsHome: string;
let sourceRoot: string;

beforeEach(() => {
  minionsHome = fs.mkdtempSync(path.join(os.tmpdir(), "owned-root-state-"));
  sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owned-root-source-"));
  vi.stubEnv("MINIONS_HOME", minionsHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(minionsHome, { recursive: true, force: true });
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

describe("workspace-owned worktree roots", () => {
  it("uses the legacy source-local root until a workspace is registered", () => {
    expect(ownedWorktreeRoot(sourceRoot)).toBe(path.join(sourceRoot, ".canvas-worktrees"));
  });

  it("moves new execution roots under central state while allowing legacy cleanup", () => {
    const workspace = registerWorkspace(sourceRoot)!;
    const central = path.join(workspace.stateRoot, "worktrees");
    const legacy = path.join(sourceRoot, ".canvas-worktrees");

    expect(ownedWorktreeRoot(sourceRoot)).toBe(central);
    expect(allowedWorktreeRoots(sourceRoot)).toEqual([central, legacy]);
    expect(isOwnedWorktreePath(sourceRoot, path.join(central, "run-1"))).toBe(true);
    expect(isOwnedWorktreePath(sourceRoot, path.join(legacy, "old-run"))).toBe(true);
    expect(isOwnedWorktreePath(sourceRoot, path.join(workspace.stateRoot, "canvas.db"))).toBe(false);
    expect(isOwnedWorktreePath(sourceRoot, path.join(sourceRoot, "src"))).toBe(false);
  });
});
