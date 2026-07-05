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
  workPacketId: string;
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
      (object_id, work_packet_id, used_at)
     VALUES (@objectId, @workPacketId, @usedAt)`,
  );
  const tx = db.transaction((rows: SystemModelUsageHit[]) => {
    for (const row of rows) stmt.run(row);
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
