import { openProjectDb } from "../project-store.ts";

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
