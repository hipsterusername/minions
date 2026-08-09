import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
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
import { findWorkspaceBySource } from "../workspace-registry.ts";

function centralDb(project: string): Database.Database {
  return new Database(path.join(findWorkspaceBySource(project)!.stateRoot, "canvas.db"));
}

describe("system-model persistence", () => {
  it("initDb creates system-model tables", () => {
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
      source: "packet",
      workPacketId: "wp-1",
      usedAt: 1,
    }]);
    const db = centralDb(project);
    const row = db.prepare(
      "SELECT object_id, work_packet_id, source, session_key FROM system_model_usage",
    ).get() as { object_id: string; work_packet_id: string; source: string; session_key: string };
    expect(row).toEqual({
      object_id: "capability.workspace_management",
      work_packet_id: "wp-1",
      source: "packet",
      session_key: "",
    });
  });

  it("attributes query usage by session without fake packet ids", () => {
    const project = copyValidFixture();
    recordSystemModelUsage(project, [
      {
        objectId: "capability.workspace_management",
        source: "query",
        sessionKey: "leader-1",
        usedAt: 1,
      },
      {
        objectId: "capability.workspace_management",
        source: "query",
        sessionKey: "leader-2",
        usedAt: 2,
      },
    ]);
    const db = centralDb(project);
    const rows = db.prepare(
      `SELECT object_id, work_packet_id, source, session_key, used_at
       FROM system_model_usage
       ORDER BY session_key`,
    ).all() as Array<{
      object_id: string;
      work_packet_id: string;
      source: string;
      session_key: string;
      used_at: number;
    }>;

    expect(rows).toEqual([
      {
        object_id: "capability.workspace_management",
        work_packet_id: "",
        source: "query",
        session_key: "leader-1",
        used_at: 1,
      },
      {
        object_id: "capability.workspace_management",
        work_packet_id: "",
        source: "query",
        session_key: "leader-2",
        used_at: 2,
      },
    ]);
    expect(rows.map((row) => row.work_packet_id)).not.toContain("leader-1");
    expect(db.prepare(
      `SELECT COUNT(*) AS count
       FROM system_model_usage usage
       LEFT JOIN work_packets packet ON packet.id = usage.work_packet_id
       WHERE usage.source = 'packet' AND packet.id IS NULL`,
    ).get()).toEqual({ count: 0 });
  });

  it("migrates legacy usage rows and widens the uniqueness key idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "system-model-usage-"));
    const dbPath = path.join(dir, "canvas.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE system_model_usage (
        object_id       TEXT NOT NULL,
        work_packet_id  TEXT NOT NULL,
        used_at         INTEGER NOT NULL,
        PRIMARY KEY (object_id, work_packet_id)
      );
      INSERT INTO system_model_usage (object_id, work_packet_id, used_at)
      VALUES ('capability.workspace_management', 'wp-old', 7);
    `);
    legacy.close();

    initDb(dbPath).close();
    initDb(dbPath).close();

    const db = new Database(dbPath);
    const row = db.prepare(
      "SELECT object_id, work_packet_id, source, session_key, used_at FROM system_model_usage",
    ).get();
    const pk = (db.pragma("table_info(system_model_usage)") as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    expect(row).toEqual({
      object_id: "capability.workspace_management",
      work_packet_id: "wp-old",
      source: "packet",
      session_key: "",
      used_at: 7,
    });
    expect(pk).toEqual(["object_id", "work_packet_id", "source", "session_key"]);
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
    const db = centralDb(project);
    const usage = db.prepare(
      "SELECT object_id, work_packet_id, source, session_key FROM system_model_usage",
    ).all() as Array<{ object_id: string; work_packet_id: string; source: string; session_key: string }>;
    expect(usage).toEqual([
      {
        object_id: "capability.workspace_management",
        work_packet_id: packet.id,
        source: "packet",
        session_key: "",
      },
      {
        object_id: "surface.mobile",
        work_packet_id: packet.id,
        source: "packet",
        session_key: "",
      },
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
  scope: { capabilities: ["capability.workspace_management"], flows: [], constraints: [], decisions: [], risks: [], surfaces: ["surface.mobile"], entryPoints: [], suggestedFiles: [], suggestedTests: [] },
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
    affectedEntryPoints: [],
    siblingSurfaces: [],
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
