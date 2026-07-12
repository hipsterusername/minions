import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLiveEditCoordinator, resetLiveEditCoordinators,
  subscribeLiveEditCoordinators } from "./live-edit-runtime.ts";

const dirs: string[] = [];
afterEach(() => { resetLiveEditCoordinators(); for (const dir of dirs.splice(0))
  fs.rmSync(dir, { recursive: true, force: true }); });

describe("live-edit coordinator registry", () => {
  it("uses one coordinator for real and symlinked project aliases", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-edit-runtime-")); dirs.push(root);
    const project = path.join(root, "project"); const alias = path.join(root, "alias");
    fs.mkdirSync(project); fs.symlinkSync(project, alias, "dir");
    const created: string[] = []; subscribeLiveEditCoordinators((projectPath) => created.push(projectPath));
    expect(getLiveEditCoordinator(project)).toBe(getLiveEditCoordinator(alias));
    expect(created).toEqual([fs.realpathSync(project)]);
  });
});
