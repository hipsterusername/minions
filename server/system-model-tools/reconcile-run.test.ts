import { describe, expect, it } from "vitest";
import type { BusPayload } from "../bus.ts";
import type { DetailedDiff } from "../worktree-types.ts";
import { loadSystemModel } from "../system-model/load.ts";
import { copyValidFixture } from "../system-model/load.test.ts";
import { getLatestReconciliationReportForPacket, saveWorkPacket } from "../system-model/store.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";
import { createReconcileRunToolDef } from "./reconcile-run.ts";

describe("reconcile_run", () => {
  it("rejects invalid input", async () => {
    const project = copyValidFixture();
    await expect(createReconcileRunToolDef(makeCtx(project)).handler({
      workPacketId: "",
      agentSummary: "done",
    })).rejects.toThrow();
  });

  it("returns deterministic report and reviewer task when constraints are in scope", async () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet, "context", 1);
    const result = await createReconcileRunToolDef(makeCtx(project)).handler({
      workPacketId: packet.id,
      agentSummary: "Changed session host.",
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      report: { id: string; deterministic: { constraintsInScope: string[] }; constraintVerdicts?: unknown[] };
      reviewerTaskDescription: string;
    };

    expect(payload.report.deterministic.constraintsInScope).toEqual(["constraint.bus_only"]);
    expect(payload.report.constraintVerdicts).toEqual([]);
    expect(payload.reviewerTaskDescription).toContain("ConstraintCheck[]");
    expect(payload.reviewerTaskDescription).toContain("appears_satisfied|possibly_violated|violated|not_checked");
    expect(getLatestReconciliationReportForPacket(project, packet.id)?.id).toBe(payload.report.id);
  });
});

function makeCtx(project: string, emissions: BusPayload[] = []) {
  const { model } = loadSystemModel(project);
  return {
    leaderSessionKey: "leader-1",
    projectPath: project,
    cwd: project,
    runtime: { mode: "advisory" as const, manifestFound: true, model, loadErrors: [] },
    bus: { emit: () => {}, emitToSession: (_: string, payload: BusPayload) => emissions.push(payload), emitToProject: () => {}, emitGlobal: () => {}, subscribe: () => () => {} },
    now: () => 100,
    getDetailedDiff: async () => diff,
  };
}

const packet: WorkPacket = {
  id: "wp_reconcile_tool",
  leaderSessionKey: "leader-1",
  createdAt: 1,
  userRequest: "request",
  normalizedGoal: "request",
  status: "active",
  scope: {
    capabilities: ["capability.workspace_management"],
    flows: [],
    constraints: ["constraint.bus_only"],
    decisions: [],
    risks: [],
    suggestedFiles: ["server/session-host.ts"],
    suggestedTests: ["server/session-host.test.ts"],
  },
  nonGoals: [],
  agentInstructions: [],
  freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
  reviewGates: [],
  riskLevel: "high",
  matchConfidence: "high",
  amendments: [],
};

const diff: DetailedDiff = {
  filesChanged: 1,
  insertions: 2,
  deletions: 0,
  branch: "work",
  commits: [],
  files: [{ file: "server/session-host.ts", insertions: 2, deletions: 0, status: "modified" }],
};
