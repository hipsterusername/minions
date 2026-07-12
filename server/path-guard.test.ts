/**
 * Unit tests for path-guard security helpers.
 *
 * NOTE: `openedProjects` is module-scoped state that persists across tests.
 * Every test that registers a path uses a unique random suffix to prevent
 * cross-test pollution.
 */

import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: require("path").resolve(require("os").tmpdir(), `minions-fakehome-path-guard-${process.pid}`),
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

import {
  isUnderHomeDir,
  registerProjectPath,
  isRegisteredProject,
  validateProjectPath,
  unregisterProjectPath,
  validateSessionCwd,
  validateOwnedSessionCwd,
  rehydrateFromPaths,
  resolveCreatableProjectPath,
  resolveExistingProjectPath,
} from "./path-guard.ts";

/**
 * Probe whether this platform/config can create symbolic links.
 * On Windows without Developer Mode the SeCreateSymbolicLink privilege is
 * absent and fs.symlinkSync throws EPERM.  Tests that require file-type
 * symlinks are skipped when this returns false; directory-type symlinks are
 * replaced with Windows junctions which work without the privilege.
 */
const canSymlink: boolean = (() => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-symlink-"));
    const src = path.join(dir, "src.txt");
    const lnk = path.join(dir, "lnk.txt");
    fs.writeFileSync(src, "x");
    fs.symlinkSync(src, lnk);
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  fs.mkdirSync(FAKE_HOME, { recursive: true });
});

afterAll(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

/** Build a unique path under home that does not need to exist on disk. */
function uniqueHomePath(label: string): string {
  const tag = `${label}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.homedir(), ".canvas-test-guard", tag);
}

function uniqueProject(label: string): string {
  const project = uniqueHomePath(label);
  fs.mkdirSync(project, { recursive: true });
  return project;
}

describe("isUnderHomeDir", () => {
  // Note: a "accepts the home directory itself" tautology was removed per §5.1.

  it("accepts a subdirectory under home", () => {
    expect(isUnderHomeDir(path.join(os.homedir(), "sub"))).toBe(true);
  });

  it("rejects /etc", () => {
    expect(isUnderHomeDir("/etc")).toBe(false);
  });

  it("rejects /usr/local", () => {
    expect(isUnderHomeDir("/usr/local")).toBe(false);
  });
});

describe("registerProjectPath", () => {
  it("rejects a path outside the home directory", () => {
    const result = registerProjectPath("/etc/outside-home");
    expect(result).toBeNull();
  });

  it("accepts a valid path under home and returns its resolved form", () => {
    const p = uniqueHomePath("register-valid");
    const result = registerProjectPath(p);
    expect(result).toBe(path.resolve(p));
  });

  it("round-trips with isRegisteredProject after a successful registration", () => {
    const p = uniqueHomePath("register-roundtrip");
    const registered = registerProjectPath(p);
    expect(registered).not.toBeNull();
    expect(isRegisteredProject(p)).toBe(true);
  });

  it("rejects a project path whose realpath escapes the home directory", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "path-guard-outside-root-"));
    const linkedProject = uniqueHomePath("linked-project");
    fs.mkdirSync(path.dirname(linkedProject), { recursive: true });
    // Use 'junction' on Windows (no SeCreateSymbolicLink needed); treated as
    // 'dir' on Linux/macOS. realpath() follows both correctly.
    fs.symlinkSync(outside, linkedProject, "junction");

    expect(registerProjectPath(linkedProject)).toBeNull();

    fs.rmSync(outside, { recursive: true, force: true });
  });
});

// Note: a standalone `describe("isRegisteredProject")` block was removed
// per testing-strategy.md §5.9 — its single assertion duplicated the
// negative branch already exercised by registerProjectPath's round-trip.

describe("validateProjectPath", () => {
  it("returns the resolved path for a registered project", () => {
    const p = uniqueHomePath("validate-registered");
    registerProjectPath(p);
    expect(validateProjectPath(p)).toBe(path.resolve(p));
  });

  it("returns null for an unregistered path", () => {
    const p = uniqueHomePath("validate-unregistered");
    expect(validateProjectPath(p)).toBeNull();
  });
});

describe("unregisterProjectPath", () => {
  it("removes the registration so subsequent lookups return false", () => {
    const p = uniqueHomePath("unregister");
    registerProjectPath(p);
    expect(isRegisteredProject(p)).toBe(true);

    unregisterProjectPath(p);
    expect(isRegisteredProject(p)).toBe(false);
  });
});

describe("rehydrateFromPaths", () => {
  it("registers all valid paths in the list", () => {
    const p1 = uniqueHomePath("rehydrate-valid-1");
    const p2 = uniqueHomePath("rehydrate-valid-2");
    rehydrateFromPaths([p1, p2]);
    expect(isRegisteredProject(p1)).toBe(true);
    expect(isRegisteredProject(p2)).toBe(true);
  });

  it("silently skips paths outside the home directory", () => {
    const valid = uniqueHomePath("rehydrate-mixed");
    expect(() => rehydrateFromPaths(["/etc/passwd", "/var/run/bad", valid])).not.toThrow();
    expect(isRegisteredProject(valid)).toBe(true);
    expect(isRegisteredProject("/etc/passwd")).toBe(false);
  });

  it("is idempotent — re-registering an already-registered path is a no-op", () => {
    const p = uniqueHomePath("rehydrate-idempotent");
    rehydrateFromPaths([p]);
    rehydrateFromPaths([p]); // second call must not throw or corrupt state
    expect(isRegisteredProject(p)).toBe(true);
  });

  it("handles an empty list without throwing", () => {
    expect(() => rehydrateFromPaths([])).not.toThrow();
  });
});

describe("validateSessionCwd", () => {
  it("accepts only an existing registered project root", () => {
    const project = uniqueProject("session-registered");
    registerProjectPath(project);
    expect(validateSessionCwd(project)).toBe(fs.realpathSync(project));

    const arbitrary = uniqueProject("session-arbitrary");
    expect(validateSessionCwd(arbitrary)).toBeNull();
  });

  it("rejects a path outside the home directory", () => {
    expect(validateSessionCwd("/var/run/something")).toBeNull();
  });

  it("accepts only an explicitly supplied active worktree path", () => {
    const worktree = uniqueProject("session-worktree");
    const sibling = uniqueProject("session-worktree-sibling");
    expect(validateOwnedSessionCwd(worktree, [worktree])).toBe(fs.realpathSync(worktree));
    expect(validateOwnedSessionCwd(sibling, [worktree])).toBeNull();
  });
});

describe("resolveExistingProjectPath", () => {
  it("resolves an existing file inside the real project root", async () => {
    const project = uniqueProject("existing-file");
    fs.writeFileSync(path.join(project, "README.md"), "ok");

    await expect(resolveExistingProjectPath(project, "README.md")).resolves.toBe(
      path.join(project, "README.md"),
    );
  });

  // File-type symlinks require SeCreateSymbolicLink on Windows (Developer Mode
  // or admin). Skip when the current environment does not support them.
  it.skipIf(!canSymlink)("allows symlinks that resolve inside the project root", async () => {
    const project = uniqueProject("inside-symlink");
    fs.writeFileSync(path.join(project, "target.txt"), "ok");
    fs.symlinkSync("target.txt", path.join(project, "linked.txt"));

    await expect(resolveExistingProjectPath(project, "linked.txt")).resolves.toBe(
      path.join(project, "linked.txt"),
    );
  });

  it.skipIf(!canSymlink)("rejects symlinks whose final target escapes the project root", async () => {
    const project = uniqueProject("outside-symlink");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-guard-outside-read-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, path.join(project, "linked-secret.txt"));

    await expect(resolveExistingProjectPath(project, "linked-secret.txt")).resolves.toBeNull();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("resolveCreatableProjectPath", () => {
  it("resolves a missing file below an existing in-project parent", async () => {
    const project = uniqueProject("creatable-file");

    await expect(resolveCreatableProjectPath(project, "nested/new.txt")).resolves.toBe(
      path.join(project, "nested", "new.txt"),
    );
  });

  it("rejects a symlink parent that resolves outside the project root", async () => {
    const project = uniqueProject("creatable-parent-symlink");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-guard-outside-parent-"));
    // Use 'junction' — no privilege needed on Windows; treated as 'dir' on Linux.
    fs.symlinkSync(outsideDir, path.join(project, "outside"), "junction");

    await expect(resolveCreatableProjectPath(project, "outside/new.txt")).resolves.toBeNull();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it.skipIf(!canSymlink)("rejects a symlink final target for write-like operations", async () => {
    const project = uniqueProject("creatable-final-symlink");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-guard-outside-write-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, path.join(project, "linked-secret.txt"));

    await expect(resolveCreatableProjectPath(project, "linked-secret.txt")).resolves.toBeNull();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
