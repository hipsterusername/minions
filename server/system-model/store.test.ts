import Database from "better-sqlite3";
import path from "path";
import { describe, expect, it } from "vitest";
import { initDb } from "../db.ts";
import { getWorkPacket, getWorkPacketContextPack, listWorkPacketVerifications, recordSystemModelUsage, recordWorkPacketVerification, saveWorkPacket } from "./store.ts";
import { copyValidFixture } from "./load.test.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";

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
});

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
