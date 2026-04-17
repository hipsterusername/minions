/**
 * Unit tests for path-guard security helpers.
 *
 * NOTE: `openedProjects` is module-scoped state that persists across tests.
 * Every test that registers a path uses a unique random suffix to prevent
 * cross-test pollution.
 */

import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import {
  isUnderHomeDir,
  registerProjectPath,
  isRegisteredProject,
  validateProjectPath,
  unregisterProjectPath,
  validateSessionCwd,
} from "./path-guard.ts";

/** Build a unique path under home that does not need to exist on disk. */
function uniqueHomePath(label: string): string {
  const tag = `${label}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.homedir(), ".canvas-test-guard", tag);
}

describe("isUnderHomeDir", () => {
  it("accepts the home directory itself", () => {
    expect(isUnderHomeDir(os.homedir())).toBe(true);
  });

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
});

describe("isRegisteredProject", () => {
  it("returns false for a path that was never registered", () => {
    const p = uniqueHomePath("never-registered");
    expect(isRegisteredProject(p)).toBe(false);
  });
});

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

describe("validateSessionCwd", () => {
  it("accepts a path under the home directory", () => {
    const p = path.join(os.homedir(), "some-project");
    expect(validateSessionCwd(p)).toBe(path.resolve(p));
  });

  it("rejects a path outside the home directory", () => {
    expect(validateSessionCwd("/var/run/something")).toBeNull();
  });
});
