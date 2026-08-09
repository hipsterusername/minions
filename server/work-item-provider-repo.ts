import type Database from "better-sqlite3";

export function updateRunProviderSessionId(db: Database.Database, runKey: string,
  providerSessionId: string, providerGeneration: number, at: number): boolean {
  return db.transaction(() => {
    const row = db.prepare(`SELECT session_id, provider_generation, ended_at FROM sessions
      WHERE session_key = ? AND work_item_id IS NOT NULL`).get(runKey) as
      { session_id: string | null; provider_generation: number; ended_at: number | null } | undefined;
    if (!row || row.ended_at !== null || providerGeneration < row.provider_generation) return false;
    if (providerGeneration === row.provider_generation) return row.session_id === providerSessionId;
    return db.prepare(`UPDATE sessions SET session_id = ?, provider_generation = ?, updated_at = ?
      WHERE session_key = ? AND ended_at IS NULL AND provider_generation < ?`)
      .run(providerSessionId, providerGeneration, new Date(at).toISOString(), runKey, providerGeneration).changes === 1;
  }).immediate();
}
