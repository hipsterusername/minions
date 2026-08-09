import { openProjectDb } from "../project-store.ts";
import {
  reconciliationReportSchema,
  workPacketSchema,
  type ReconciliationReport,
  type RequiredVerification,
  type WorkPacket,
} from "../../shared/system-model/index.ts";

export interface SystemModelUsageHit {
  objectId: string;
  source: "packet" | "query";
  workPacketId?: string;
  sessionKey?: string;
  usedAt: number;
}

export function recordSystemModelUsage(
  projectPath: string,
  hits: SystemModelUsageHit[],
): void {
  if (hits.length === 0) return;
  const db = openProjectDb(projectPath);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO system_model_usage
      (object_id, work_packet_id, source, session_key, used_at)
     VALUES (@objectId, @workPacketId, @source, @sessionKey, @usedAt)`,
  );
  const tx = db.transaction((rows: SystemModelUsageHit[]) => {
    for (const row of rows) stmt.run(normalizeUsageHit(row));
  });
  tx(hits);
}

export interface StoredWorkPacket {
  packet: WorkPacket;
  contextPack: string;
}

export interface WorkPacketVerificationRow {
  workPacketId: string;
  kind: RequiredVerification["kind"];
  target: string;
  result: RequiredVerification["status"];
  notes?: string | null;
  recordedAt: number;
}

export function saveWorkPacket(
  projectPath: string,
  packet: WorkPacket,
  contextPack: string,
  now = Date.now(),
): void {
  const db = openProjectDb(projectPath);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO work_packets
        (id, leader_session_key, status, risk_level, user_request, packet_json, context_pack, created_at, updated_at)
       VALUES (@id, @leaderSessionKey, @status, @riskLevel, @userRequest, @packetJson, @contextPack, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
        leader_session_key = excluded.leader_session_key,
        status = excluded.status,
        risk_level = excluded.risk_level,
        user_request = excluded.user_request,
        packet_json = excluded.packet_json,
        context_pack = excluded.context_pack,
        updated_at = excluded.updated_at`,
    ).run({
      id: packet.id,
      leaderSessionKey: packet.leaderSessionKey,
      status: packet.status,
      riskLevel: packet.riskLevel,
      userRequest: packet.userRequest,
      packetJson: JSON.stringify(packet),
      contextPack,
      createdAt: packet.createdAt,
      updatedAt: now,
    });
    const usage = usageHitsForPacket(packet, now);
    if (usage.length > 0) {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO system_model_usage
          (object_id, work_packet_id, source, session_key, used_at)
         VALUES (@objectId, @workPacketId, @source, @sessionKey, @usedAt)`,
      );
      for (const row of usage) stmt.run(normalizeUsageHit(row));
    }
  });
  tx();
}

export function getWorkPacket(projectPath: string, id: string): StoredWorkPacket | null {
  const db = openProjectDb(projectPath);
  const row = db.prepare(
    "SELECT packet_json, context_pack FROM work_packets WHERE id = ?",
  ).get(id) as { packet_json: string; context_pack: string } | undefined;
  if (!row) return null;
  return {
    packet: workPacketSchema.parse(JSON.parse(row.packet_json)),
    contextPack: row.context_pack,
  };
}

export function getWorkPacketContextPack(projectPath: string, id: string): string | null {
  return getWorkPacket(projectPath, id)?.contextPack ?? null;
}

export function waiveLatestWorkPacketGate(
  projectPath: string,
  leaderSessionKey: string,
  gateId: string,
  reason: string,
  now = Date.now(),
): WorkPacket | null {
  const db = openProjectDb(projectPath);
  const row = db.prepare(
    `SELECT id, packet_json, context_pack
     FROM work_packets
     WHERE leader_session_key = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
  ).get(leaderSessionKey) as { id: string; packet_json: string; context_pack: string } | undefined;
  if (!row) return null;

  const packet = workPacketSchema.parse(JSON.parse(row.packet_json));
  const reviewGates = packet.reviewGates.map((gate) =>
    gate.gateId === gateId ? { ...gate, status: "waived" as const, reason, waivedAt: now } : gate,
  );
  if (!reviewGates.some((gate) => gate.gateId === gateId)) {
    reviewGates.push({ gateId, name: gateId, status: "waived", reason, waivedAt: now });
  }
  const waivedPacket = { ...packet, reviewGates };
  saveWorkPacket(projectPath, waivedPacket, row.context_pack, now);
  waiveLatestReconciliationGate(db, row.id, gateId, reason, now);
  return waivedPacket;
}

export function updateWorkPacketStatus(
  projectPath: string,
  id: string,
  status: WorkPacket["status"],
  now = Date.now(),
): WorkPacket | null {
  const stored = getWorkPacket(projectPath, id);
  if (!stored) return null;
  const packet = { ...stored.packet, status };
  saveWorkPacket(projectPath, packet, stored.contextPack, now);
  return packet;
}

export function recordWorkPacketVerification(
  projectPath: string,
  row: WorkPacketVerificationRow,
): void {
  const db = openProjectDb(projectPath);
  db.prepare(
    `INSERT OR REPLACE INTO work_packet_verifications
      (work_packet_id, kind, target, result, notes, recorded_at)
     VALUES (@workPacketId, @kind, @target, @result, @notes, @recordedAt)`,
  ).run(row);
}

export function listWorkPacketVerifications(
  projectPath: string,
  workPacketId: string,
): WorkPacketVerificationRow[] {
  const db = openProjectDb(projectPath);
  const rows = db.prepare(
    `SELECT work_packet_id, kind, target, result, notes, recorded_at
     FROM work_packet_verifications
     WHERE work_packet_id = ?
     ORDER BY kind, target`,
  ).all(workPacketId) as Array<{
    work_packet_id: string;
    kind: RequiredVerification["kind"];
    target: string;
    result: RequiredVerification["status"];
    notes: string | null;
    recorded_at: number;
  }>;
  return rows.map((row) => ({
    workPacketId: row.work_packet_id,
    kind: row.kind,
    target: row.target,
    result: row.result,
    notes: row.notes,
    recordedAt: row.recorded_at,
  }));
}

export function saveReconciliationReport(
  projectPath: string,
  report: ReconciliationReport,
): void {
  const db = openProjectDb(projectPath);
  db.prepare(
    `INSERT INTO reconciliation_reports
      (id, work_packet_id, report_json, created_at)
     VALUES (@id, @workPacketId, @reportJson, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
      work_packet_id = excluded.work_packet_id,
      report_json = excluded.report_json,
      created_at = excluded.created_at`,
  ).run({
    id: report.id,
    workPacketId: report.workPacketId,
    reportJson: JSON.stringify(report),
    createdAt: report.createdAt,
  });
}

export function getReconciliationReport(
  projectPath: string,
  id: string,
): ReconciliationReport | null {
  const db = openProjectDb(projectPath);
  const row = db.prepare(
    "SELECT report_json FROM reconciliation_reports WHERE id = ?",
  ).get(id) as { report_json: string } | undefined;
  return row ? reconciliationReportSchema.parse(JSON.parse(row.report_json)) : null;
}

export function getLatestReconciliationReportForPacket(
  projectPath: string,
  workPacketId: string,
): ReconciliationReport | null {
  const db = openProjectDb(projectPath);
  const row = db.prepare(
    `SELECT report_json FROM reconciliation_reports
     WHERE work_packet_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(workPacketId) as { report_json: string } | undefined;
  return row ? reconciliationReportSchema.parse(JSON.parse(row.report_json)) : null;
}

function waiveLatestReconciliationGate(
  db: ReturnType<typeof openProjectDb>,
  workPacketId: string,
  gateId: string,
  reason: string,
  now: number,
): void {
  const row = db.prepare(
    `SELECT id, report_json FROM reconciliation_reports
     WHERE work_packet_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(workPacketId) as { id: string; report_json: string } | undefined;
  if (!row) return;
  const report = reconciliationReportSchema.parse(JSON.parse(row.report_json));
  const waive = <T extends { gateId: string; name: string }>(gates: T[]) =>
    gates.map((gate) =>
      gate.gateId === gateId ? { ...gate, status: "waived" as const, reason, waivedAt: now } : gate,
    );
  const updated = {
    ...report,
    gates: waive(report.gates),
    deterministic: {
      ...report.deterministic,
      gateRequirements: waive(report.deterministic.gateRequirements),
    },
  };
  db.prepare(
    `UPDATE reconciliation_reports
     SET report_json = ?
     WHERE id = ?`,
  ).run(JSON.stringify(updated), row.id);
}

function usageHitsForPacket(packet: WorkPacket, usedAt: number): SystemModelUsageHit[] {
  return [
    ...packet.scope.capabilities,
    ...packet.scope.flows,
    ...packet.scope.constraints,
    ...packet.scope.decisions,
    ...packet.scope.risks,
    ...(packet.scope.surfaces ?? []),
  ].map((objectId) => ({ objectId, source: "packet", workPacketId: packet.id, usedAt }));
}

function normalizeUsageHit(hit: SystemModelUsageHit): {
  objectId: string;
  workPacketId: string;
  source: SystemModelUsageHit["source"];
  sessionKey: string;
  usedAt: number;
} {
  return {
    objectId: hit.objectId,
    workPacketId: hit.source === "packet" ? hit.workPacketId ?? "" : "",
    source: hit.source,
    sessionKey: hit.sessionKey ?? "",
    usedAt: hit.usedAt,
  };
}
