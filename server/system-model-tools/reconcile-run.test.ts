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
      report: {
        id: string;
        deterministic: { constraintsInScope: string[]; candidateModelObjects: string[] };
        constraintVerdicts?: unknown[];
        systemModelUpdate: { status: string; provenance: string };
      };
      reviewerTaskDescription: string;
      pendingActions: string[];
    };

    expect(payload.report.deterministic.constraintsInScope).toEqual(["constraint.bus_only"]);
    expect(payload.report.constraintVerdicts).toEqual([]);
    expect(payload.report.deterministic.candidateModelObjects).toContain("capability.workspace_management");
    expect(payload.report.systemModelUpdate).toMatchObject({
      status: "review_required",
      provenance: "deterministic",
    });
    expect(payload.pendingActions).toHaveLength(2);
    expect(payload.reviewerTaskDescription).toContain("ConstraintCheck[]");
    expect(payload.reviewerTaskDescription).toContain("appears_satisfied|possibly_violated|violated|not_checked");
    expect(getLatestReconciliationReportForPacket(project, packet.id)?.id).toBe(payload.report.id);
  });

  it("accepts an evidence-backed no-change assessment but keeps constraint review pending", async () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet, "context", 1);
    const result = await createReconcileRunToolDef(makeCtx(project)).handler({
      workPacketId: packet.id,
      agentSummary: "Changed session host implementation only.",
      systemModelUpdate: {
        status: "no_change_needed",
        rationale: "The capability and invariant remain accurate.",
        evidence: ["Reviewed .systemmodel/capabilities/workspace.yaml against the diff"],
      },
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      report: { systemModelUpdate: { status: string; provenance: string; candidateObjectIds: string[] } };
      pendingActions: string[];
    };

    expect(payload.report.systemModelUpdate).toMatchObject({
      status: "no_change_needed",
      provenance: "leader_judged",
    });
    expect(payload.report.systemModelUpdate.candidateObjectIds).toContain("capability.workspace_management");
    expect(payload.pendingActions).toEqual(["Record reviewer constraint verdicts"]);
  });

  it("requires a real model-file diff for an updated assessment", async () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet, "context", 1);
    await expect(createReconcileRunToolDef(makeCtx(project)).handler({
      workPacketId: packet.id,
      agentSummary: "Updated implementation.",
      systemModelUpdate: {
        status: "updated",
        rationale: "Guidance changed.",
        evidence: ["pnpm system-model:validate"],
      },
    })).rejects.toThrow(/requires a changed \.systemmodel file/);
  });

  it("requires an explicit assessment to cover every deterministic candidate", async () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet, "context", 1);
    await expect(createReconcileRunToolDef(makeCtx(project)).handler({
      workPacketId: packet.id,
      agentSummary: "Changed modeled implementation.",
      systemModelUpdate: {
        status: "no_change_needed",
        objectIds: ["flow.approve_changes"],
        rationale: "No guidance changed.",
        evidence: ["Reviewed the flow"],
      },
    })).rejects.toThrow(/does not cover candidate object capability\.workspace_management/);
  });

  it("automatically reconciles when no criteria, constraints, or model update are pending", async () => {
    const project = copyValidFixture();
    const unmodeledPacket: WorkPacket = {
      ...packet,
      id: "wp_unmodeled",
      scope: {
        capabilities: [], flows: [], constraints: [], decisions: [], risks: [],
        suggestedFiles: ["README.md"], suggestedTests: [],
      },
    };
    saveWorkPacket(project, unmodeledPacket, "context", 1);
    const noModelDiff: DetailedDiff = {
      ...diff,
      files: [{ file: "README.md", insertions: 2, deletions: 0, status: "modified" }],
    };
    const result = await createReconcileRunToolDef(makeCtx(project, [], noModelDiff)).handler({
      workPacketId: unmodeledPacket.id,
      agentSummary: "Updated documentation.",
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      packet: { status: string };
      pendingActions: string[];
    };

    expect(payload.pendingActions).toEqual([]);
    expect(payload.packet.status).toBe("reconciled");
  });
});

function makeCtx(project: string, emissions: BusPayload[] = [], detailedDiff = diff) {
  const { model } = loadSystemModel(project);
  return {
    leaderSessionKey: "leader-1",
    projectPath: project,
    cwd: project,
    runtime: { mode: "advisory" as const, manifestFound: true, model, loadErrors: [] },
    bus: { emit: () => {}, emitToSession: (_: string, payload: BusPayload) => emissions.push(payload), emitToProject: () => {}, emitGlobal: () => {}, subscribe: () => () => {} },
    now: () => 100,
    getDetailedDiff: async () => detailedDiff,
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
