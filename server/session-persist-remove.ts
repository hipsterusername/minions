import type Database from "better-sqlite3";
import * as repo from "./session-repo.ts";

/** Legacy session deletion must never erase immutable work-item run history. */
export function removeSessionPersistence(
  db: Database.Database,
  sessionKey: string,
): boolean {
  return db.transaction(() => {
    const run = db.prepare(
      "SELECT work_item_id FROM sessions WHERE session_key = ?",
    ).get(sessionKey) as { work_item_id: string | null } | undefined;
    if (run?.work_item_id) return false;

    repo.deleteSession(db, sessionKey);
    repo.deleteRenderState(db, sessionKey);
    repo.purgeEventsForSession(db, sessionKey);
    db.prepare("DELETE FROM context_checkpoints WHERE session_key = ?").run(sessionKey);
    db.prepare("DELETE FROM task_records WHERE leader_session_key = ?").run(sessionKey);
    return true;
  }).immediate();
}
