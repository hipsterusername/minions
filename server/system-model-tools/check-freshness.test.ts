import { describe, expect, it } from "vitest";
import { loadSystemModel } from "../system-model/load.ts";
import { copyValidFixture } from "../system-model/load.test.ts";
import { createCheckFreshnessToolDef } from "./check-freshness.ts";

describe("check_freshness", () => {
  it("rejects invalid input", async () => {
    const project = copyValidFixture();
    const def = createCheckFreshnessToolDef(makeCtx(project));
    await expect(def.handler({ objectIds: "capability.workspace_management" })).rejects.toThrow();
  });

  it("reports per-object stale status through freshness.ts", async () => {
    const project = copyValidFixture();
    const def = createCheckFreshnessToolDef(makeCtx(project));
    const result = await def.handler({ objectIds: ["capability.workspace_management"] });
    const payload = JSON.parse(result.content[0]!.text) as {
      status: string;
      requiredVerifications: Array<{ target: string }>;
    };

    expect(payload.status).toBe("partially_stale");
    expect(payload.requiredVerifications).toEqual([
      expect.objectContaining({ target: "capability.workspace_management" }),
    ]);
  });
});

function makeCtx(project: string) {
  const { model } = loadSystemModel(project);
  return {
    leaderSessionKey: "leader-1",
    projectPath: project,
    cwd: project,
    runtime: { mode: "advisory" as const, manifestFound: true, model, loadErrors: [] },
    bus: { emit: () => {}, emitToSession: () => {}, emitToProject: () => {}, emitGlobal: () => {}, subscribe: () => () => {} },
    getHeadSha: async () => "head",
    timestampFn: async () => ({ modelTouchedAt: 10, codeTouchedAt: 20 }),
  };
}
