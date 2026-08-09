import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerProjectPath, unregisterProjectPath } from "./path-guard.ts";
import { ensureProjectRow } from "./routes/projects/helpers.ts";
import { encodePath } from "./routes/projects/helpers.ts";
import { openProjectDb } from "./project-store.ts";
import { legacyProjectIdentity } from "./work-item-migration.ts";
import { resolveWorkItemProject } from "./work-item-project.ts";

let projectPath: string;

describe("work-item project ownership", () => {
  beforeEach(() => { projectPath = fs.mkdtempSync(path.join(process.cwd(), ".work-item-project-test-")); });
  afterEach(() => {
    unregisterProjectPath(projectPath);
    fs.rmSync(projectPath, { recursive: true, force: true });
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
