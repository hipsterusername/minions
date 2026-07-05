import { describe, expect, it } from "vitest";
import { loadSystemModel } from "../system-model/load.ts";
import { copyValidFixture } from "../system-model/load.test.ts";
import { createModelHealthToolDef } from "./model-health.ts";
import type { BusPayload } from "../bus.ts";

describe("model_health", () => {
  it("returns unused, stale, orphaned, and prune recommendation data", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    model!.capabilities[0]!.risks = [];
    model!.flows[0]!.risks = [];
    model!.risks[0]!.appliesTo = { capabilities: [], flows: [], files: [] };
    const def = createModelHealthToolDef({
      leaderSessionKey: "leader-1",
      projectPath: project,
      cwd: project,
      runtime: { mode: "advisory", manifestFound: true, model, loadErrors: [] },
      bus: bus(),
      getHeadSha: async () => "head",
      timestampFn: async ({ objectFile }) => ({
        modelTouchedAt: objectFile.includes("workspace_management") ? 10 : 30,
        codeTouchedAt: objectFile.includes("workspace_management") ? 20 : 5,
      }),
    });

    const result = await def.handler({ unusedPacketWindow: 30 });
    const payload = JSON.parse(result.content[0]!.text) as {
      unused: Array<{ id: string }>;
      stale: Array<{ id: string }>;
      orphaned: Array<{ id: string }>;
      pruneRecommendations: Array<{ id: string; reasons: string[]; recommendation: string }>;
    };

    expect(payload.unused.map((item) => item.id)).toContain("capability.workspace_management");
    expect(payload.stale.map((item) => item.id)).toEqual(["capability.workspace_management"]);
    expect(payload.orphaned.map((item) => item.id)).toEqual(["risk.merge_bypass"]);
    expect(payload.pruneRecommendations).toContainEqual(expect.objectContaining({
      id: "capability.workspace_management",
      recommendation: "prune_or_update",
    }));
    expect(payload.pruneRecommendations).toContainEqual(expect.objectContaining({
      id: "risk.merge_bypass",
      recommendation: "prune_or_link",
    }));
  });
});

function bus() {
  return {
    emit: () => {},
    emitToSession: (_: string, _payload: BusPayload) => {},
    emitToProject: () => {},
    emitGlobal: () => {},
    subscribe: () => () => {},
  };
}
