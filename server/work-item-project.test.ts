import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProjectPath, unregisterProjectPath } from "./path-guard.ts";
import { ensureProjectRow } from "./routes/projects/helpers.ts";
import { encodePath } from "./routes/projects/helpers.ts";
import { openProjectDb } from "./project-store.ts";
import { legacyProjectIdentity } from "./work-item-migration.ts";
import { resolveWorkItemProject, resolveWorkItemProjectIdentity } from "./work-item-project.ts";
import { registerWorkspace } from "./workspace-registry.ts";

let projectPath: string;
let minionsHome: string;

describe("work-item project ownership", () => {
  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(process.cwd(), ".work-item-project-test-"));
    minionsHome = fs.mkdtempSync(path.join(process.cwd(), ".work-item-project-home-test-"));
    vi.stubEnv("MINIONS_HOME", minionsHome);
  });
  afterEach(() => {
    unregisterProjectPath(projectPath);
    fs.rmSync(projectPath, { recursive: true, force: true });
    fs.rmSync(minionsHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("accepts the stable UUID of the workspace registered for the source", () => {
    const workspace = registerWorkspace(projectPath);
    expect(workspace).not.toBeNull();
    registerProjectPath(projectPath);

    expect(resolveWorkItemProject(workspace!.id, projectPath)).toBe(workspace!.sourceRoot);
  });

  it("enumerates every pre-UUID project identity for lazy migration", () => {
    const workspace = registerWorkspace(projectPath)!;
    const db = openProjectDb(projectPath);
    const storedId = ensureProjectRow(db, projectPath);
    db.close();

    expect(resolveWorkItemProjectIdentity(workspace.id)).toEqual({
      projectId: workspace.id,
      projectPath: workspace.sourceRoot,
      aliases: expect.arrayContaining([
        storedId,
        encodePath(workspace.sourceRoot),
        legacyProjectIdentity(null, workspace.sourceRoot, null).projectId,
      ]),
    });
  });

  it("accepts the public path id, sidecar id, and legacy path-derived alias", () => {
    registerProjectPath(projectPath);
    const db = openProjectDb(projectPath);
    const projectId = ensureProjectRow(db, projectPath);
    db.close();

    expect(resolveWorkItemProject(projectId, projectPath)).toBe(projectPath);
    expect(resolveWorkItemProject(encodePath(projectPath), projectPath)).toBe(projectPath);
    expect(resolveWorkItemProject(
      legacyProjectIdentity(null, projectPath, null).projectId, projectPath,
    )).toBe(projectPath);
  });

  it("rejects an unrelated project id even for a registered path", () => {
    registerProjectPath(projectPath);
    expect(resolveWorkItemProject("foreign-project", projectPath)).toBeNull();
  });
});
