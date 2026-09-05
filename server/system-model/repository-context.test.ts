import { readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { compileWorkPacket } from "./compile.ts";
import { clearFreshnessCache } from "./freshness.ts";
import { loadSystemModel } from "./load.ts";
import { matchSystemModel } from "./match.ts";
import { validateLoadedSystemModel } from "./validate.ts";

const model = () => loadSystemModel(process.cwd()).model!;
async function compile(id: string, files: string[] = []) {
  const source = model();
  return compileWorkPacket({ model: source, cwd: process.cwd(), headSha: "repository-context",
    mode: "advisory", userRequest: id, normalizedGoal: id,
    matchedCandidates: [{ id, type: source.objectsById.get(id)!.type, score: 10, reasons: [] }],
    matchConfidence: "high", taskFiles: files, timestampFn: async () => ({ modelTouchedAt: 1, codeTouchedAt: 2 }), now: 3 });
}
const gates = (result: Awaited<ReturnType<typeof compile>>) => result.packet.reviewGates
  .filter((gate) => gate.status === "required_pending").map((gate) => gate.gateId);

describe("repository model context quality", () => {
  beforeEach(clearFreshnessCache);

  it("uses the authored context budgets", () => {
    expect(model().policies.contextBudgets).toEqual({ leaderPromptAddendum: 2400, minionContextPack: 4800, perObjectSummary: 420 });
  });

  it("does not use navigation hints to activate unrelated gates without task files", async () => {
    const graph = await compile("capability.execution_graph_runtime");
    expect(gates(graph)).toEqual(["gate.execution_graph_runtime"]);
    const canvas = await compile("capability.spatial_canvas");
    expect(gates(canvas)).toEqual([]);
    expect(canvas.packet.riskLevel).toBe("medium");
  });

  it("keeps canvas navigation scoped to its own guidance", async () => {
    const result = await compile("flow.navigate_spatial_workspace", ["src/CanvasMiniMap.tsx"]);
    expect(gates(result)).toEqual([]);
    expect(result.packet.riskLevel).toBe("medium");
    expect(result.packetRequired).toBe(false);
    expect(result.packet.scope.capabilities).toEqual(["capability.spatial_canvas"]);
    expect(result.packet.scope.constraints).not.toContain("constraint.bus_only_broadcast");
    expect(result.contextPack).toContain("Capability capability.spatial_canvas:");
    expect(result.contextPack).toContain("Flow flow.navigate_spatial_workspace:");
    expect(result.contextPack).not.toContain("server/commands");
  });

  it("retains graph authority without unrelated subsystem gates", async () => {
    const result = await compile("capability.execution_graph_runtime", ["server/task-graph/scheduler.ts"]);
    expect(gates(result)).toEqual(["gate.execution_graph_runtime"]);
    expect(result.packet.scope.constraints).toContain("constraint.execution_graph_authority");
    expect(result.packet.scope.flows).not.toContain("flow.conduct_dialectic");
    expect(result.packet.scope.constraints).not.toContain("constraint.dialectic_reasoning_integrity");
    expect(result.contextPack).toContain("Capability capability.execution_graph_runtime:");
    expect(result.contextPack).toContain("Constraint constraint.execution_graph_authority:");
    expect(Math.ceil(result.contextPack.length / 4)).toBeLessThanOrEqual(4800);
  });

  it("does not turn explanatory integration links into model-edit scope", async () => {
    const result = await compile("capability.system_model_guidance", ["server/system-model/compile.ts"]);
    expect(result.packet.scope.flows).not.toContain("flow.review_legacy_changes");
    expect(gates(result)).toEqual(["gate.system_model_core"]);
    expect(result.contextPack).toContain("Capability capability.system_model_guidance:");
  });

  it("emits authored freshness actions for stale task guidance", async () => {
    const result = await compile("capability.spatial_canvas");
    expect(result.freshnessReport.requiredAgentActions).toContain("Inspect referenced implementation and tests");
    expect(result.contextPack).toContain("Inspect referenced implementation and tests");
  });

  it("keeps notification work distinct from launch, chat, and approval", async () => {
    const result = await compile("capability.mobile_remote_control", ["src/mobile/push.ts"]);
    expect(result.packet.scope.flows).toEqual([]);
    expect(gates(result)).toEqual([]);
    expect(result.contextPack).not.toContain("ReviewChangesScreen");
  });

  it("retrieves canonical continuation guidance among the top three", () => {
    const result = matchSystemModel({ model: model(), request: "change canonical follow-up guidance",
      files: ["server/work-item-continuation.ts"], topK: 3 });
    expect(result.candidates.map((candidate) => candidate.id)).toContain("capability.conversation_steering");
  });

  it("has valid implementation and test anchors including untracked new files", () => {
    const files = repositoryFiles();
    expect(validateLoadedSystemModel(model(), files)).toEqual([]);
  });
});

function repositoryFiles(dir = "."): string[] {
  const ignored = new Set(["node_modules", ".git", ".minions", ".canvas-worktrees", "dist", "coverage"]);
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) return [];
    const file = dir === "." ? entry.name : `${dir}/${entry.name}`;
    return entry.isDirectory() ? repositoryFiles(file) : [file];
  });
}
