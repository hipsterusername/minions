import { describe, expect, it } from "vitest";
import type { BusPayload } from "../bus.ts";
import { copyValidFixture } from "../system-model/load.test.ts";
import {
  getLatestReconciliationReportForPacket,
  getWorkPacket,
  saveReconciliationReport,
  saveWorkPacket,
} from "../system-model/store.ts";
import type { ReconciliationReport, WorkPacket } from "../../shared/system-model/index.ts";
import { createRecordConstraintVerdictsToolDef } from "./record-constraint-verdicts.ts";

describe("record_constraint_verdicts", () => {
  it("validates ConstraintCheck[] input", async () => {
    const project = copyValidFixture();
    await expect(createRecordConstraintVerdictsToolDef(makeCtx(project)).handler({
      workPacketId: "wp",
      verdicts: [{ constraintId: "constraint.bus_only", status: "ok" }],
    })).rejects.toThrow();
  });

  it("merges minion verdicts, persists the report, reconciles the packet, and emits", async () => {
    const project = copyValidFixture();
    const emissions: BusPayload[] = [];
    saveWorkPacket(project, packet, "context", 1);
    saveReconciliationReport(project, report);

    const result = await createRecordConstraintVerdictsToolDef(makeCtx(project, emissions)).handler({
      workPacketId: packet.id,
      verdicts: [{
        constraintId: "constraint.bus_only",
        status: "appears_satisfied",
        evidence: ["server/session-host.ts uses Bus helpers"],
      }],
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      report: { constraintVerdicts: Array<{ provenance: string; status: string }> };
      packet: { status: string };
    };

    expect(payload.report.constraintVerdicts[0]).toMatchObject({
      provenance: "minion_judged",
      status: "appears_satisfied",
    });
    expect(payload.packet.status).toBe("reconciled");
    expect(getWorkPacket(project, packet.id)?.packet.status).toBe("reconciled");
    expect(getLatestReconciliationReportForPacket(project, packet.id)?.provenance).toEqual({
      deterministic: "deterministic",
      constraintVerdicts: "minion_judged",
    });
    expect(emissions.map((event) => event.type)).toContain("reconciliation_ready");
  });
});

function makeCtx(project: string, emissions: BusPayload[] = []) {
  return {
    leaderSessionKey: "leader-1",
    projectPath: project,
    cwd: project,
    runtime: { mode: "advisory" as const, manifestFound: true, model: null, loadErrors: [] },
    bus: { emit: () => {}, emitToSession: (_: string, payload: BusPayload) => emissions.push(payload), emitToProject: () => {}, emitGlobal: () => {}, subscribe: () => () => {} },
    now: () => 200,
  };
}

const packet: WorkPacket = {
  id: "wp_record_tool",
  leaderSessionKey: "leader-1",
  createdAt: 1,
  userRequest: "request",
  normalizedGoal: "request",
  status: "active",
  scope: { capabilities: [], flows: [], constraints: [], decisions: [], risks: [], suggestedFiles: [], suggestedTests: [] },
  nonGoals: [],
  agentInstructions: [],
  freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
  reviewGates: [],
  riskLevel: "low",
  matchConfidence: "high",
  amendments: [],
};

const report: ReconciliationReport = {
  id: "recon_record_tool",
  workPacketId: packet.id,
  createdAt: 100,
  deterministic: {
    provenance: "deterministic",
    changedFiles: ["server/session-host.ts"],
    affectedCapabilities: [],
    affectedFlows: [],
    constraintsInScope: ["constraint.bus_only"],
    testsMissing: [],
    outOfScopeFiles: [],
    gateRequirements: [],
    diffSummary: "1 file changed",
  },
  constraintVerdicts: [],
  provenance: { deterministic: "deterministic" },
  affectedObjects: [],
  changedFiles: ["server/session-host.ts"],
  testsMissing: [],
  outOfScopeFiles: [],
  gates: [],
  constraintChecks: [],
};
