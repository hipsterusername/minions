import Database from "better-sqlite3";
import path from "path";
import { describe, expect, it } from "vitest";
import { initDb } from "../db.ts";
import {
  getLatestReconciliationReportForPacket,
  getReconciliationReport,
  getWorkPacket,
  getWorkPacketContextPack,
  listWorkPacketVerifications,
  recordSystemModelUsage,
  recordWorkPacketVerification,
  saveReconciliationReport,
  saveWorkPacket,
  updateWorkPacketStatus,
  waiveLatestWorkPacketGate,
} from "./store.ts";
import { copyValidFixture } from "./load.test.ts";
import type { ReconciliationReport, WorkPacket } from "../../shared/system-model/index.ts";

describe("system-model persistence", () => {
  it("initDb creates Phase 1 tables", () => {
    const db = initDb(":memory:");
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      "work_packets",
      "work_packet_verifications",
      "reconciliation_reports",
      "system_model_usage",
    ]));
  });

  it("records usage hits", () => {
    const project = copyValidFixture();
    recordSystemModelUsage(project, [{
      objectId: "capability.workspace_management",
      workPacketId: "leader-1",
      usedAt: 1,
    }]);
    const db = new Database(path.join(project, ".minions/canvas.db"));
    const row = db.prepare("SELECT object_id FROM system_model_usage").get() as { object_id: string };
    expect(row.object_id).toBe("capability.workspace_management");
  });

  it("round-trips work packets, context packs, and verifications", () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet, "context pack", 2);
    recordWorkPacketVerification(project, {
      workPacketId: packet.id,
      kind: "freshness",
      target: "capability.workspace_management",
      result: "passed",
      notes: "ok",
      recordedAt: 3,
    });

    expect(getWorkPacket(project, packet.id)?.packet.id).toBe(packet.id);
    expect(getWorkPacketContextPack(project, packet.id)).toBe("context pack");
    expect(listWorkPacketVerifications(project, packet.id)).toEqual([
      expect.objectContaining({ target: "capability.workspace_management", result: "passed" }),
    ]);
  });

  it("round-trips reconciliation reports and packet status updates", () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet, "context pack", 2);
    saveReconciliationReport(project, report);

    expect(getReconciliationReport(project, report.id)?.deterministic.provenance).toBe("deterministic");
    expect(getLatestReconciliationReportForPacket(project, packet.id)?.id).toBe(report.id);
    expect(updateWorkPacketStatus(project, packet.id, "reconciled", 4)?.status).toBe("reconciled");
    expect(getWorkPacket(project, packet.id)?.packet.status).toBe("reconciled");
  });

  it("persists gate waivers on the packet and latest reconciliation report", () => {
    const project = copyValidFixture();
    saveWorkPacket(project, { ...packet, reviewGates: [gate("required_pending", "pending")] }, "context pack", 2);
    saveReconciliationReport(project, {
      ...report,
      gates: [gate("failed", "failed")],
      deterministic: { ...report.deterministic, gateRequirements: [gate("failed", "failed")] },
    });

    const waived = waiveLatestWorkPacketGate(project, "leader-1", "gate.review", "human accepted risk", 5);

    expect(waived?.reviewGates[0]).toMatchObject({
      gateId: "gate.review",
      status: "waived",
      reason: "human accepted risk",
      waivedAt: 5,
    });
    expect(getLatestReconciliationReportForPacket(project, packet.id)?.gates[0]).toMatchObject({
      status: "waived",
      reason: "human accepted risk",
      waivedAt: 5,
    });
  });
});

function gate(status: WorkPacket["reviewGates"][number]["status"], reason: string): WorkPacket["reviewGates"][number] {
  return { gateId: "gate.review", name: "Human Review", status, reason };
}

const packet: WorkPacket = {
  id: "wp_store",
  leaderSessionKey: "leader-1",
  createdAt: 1,
  userRequest: "request",
  normalizedGoal: "request",
  status: "draft",
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
  id: "recon_store",
  workPacketId: packet.id,
  createdAt: 3,
  deterministic: {
    provenance: "deterministic",
    changedFiles: ["server/session-host.ts"],
    affectedCapabilities: ["capability.workspace_management"],
    affectedFlows: [],
    constraintsInScope: ["constraint.bus_only"],
    testsMissing: [],
    outOfScopeFiles: [],
    gateRequirements: [],
    diffSummary: "1 file changed",
  },
  constraintVerdicts: [],
  provenance: { deterministic: "deterministic" },
  affectedObjects: ["capability.workspace_management"],
  changedFiles: ["server/session-host.ts"],
  testsMissing: [],
  outOfScopeFiles: [],
  gates: [],
  constraintChecks: [],
};
