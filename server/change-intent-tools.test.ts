import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChangeIntentTools } from "./change-intent-tools.ts";
import { createLiveEditCoordinator } from "./live-edit-coordinator.ts";
import { RunMutationCoordination } from "./mutation-coordination.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function output(result: Awaited<ReturnType<ReturnType<typeof createChangeIntentTools>[number]["handler"]>>) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("change-intent normalized tools", () => {
  it("opens and closes the same run-scoped coordinator token", async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "change-intent-tools-")); dirs.push(projectPath);
    fs.writeFileSync(path.join(projectPath, "a.ts"), "a");
    const coordinator = createLiveEditCoordinator({ projectPath, token: () => "intent-token" });
    const bridge = new RunMutationCoordination(coordinator, projectPath, "work", "run");
    const [open, close] = createChangeIntentTools(bridge);
    const opened = output(await open!.handler({ paths: [{ path: "a.ts", scope: "file" }] }));
    expect(opened).toMatchObject({ token: "intent-token", paths: ["a.ts"] });
    expect(coordinator.snapshotRun("run").state).toBe("editing");
    expect(output(await close!.handler({ token: "intent-token" }))).toMatchObject({ closed: true });
    expect(coordinator.snapshotRun("run").state).toBe("clean");
  });

  it("rejects callers outside a canonical live run", async () => {
    const [open] = createChangeIntentTools(undefined);
    await expect(open!.handler({ repositoryWide: true })).rejects.toThrow(
      "canonical live-mode work item");
  });
});
