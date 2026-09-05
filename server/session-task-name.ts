import type { SessionHost } from "./session-host.ts";
import { deriveTaskName } from "./session-host-config.ts";
import { persistenceDb } from "./session-persist.ts";
import { loadContinuitySnapshot } from "./session-continuity.ts";

/** New iterations inherit the original primary leader's name, never a child's. */
export function seedTaskName(host: SessionHost, prompt: string): void {
  const db = persistenceDb();
  if (db && host.workItemId && host.role === "leader" && host.runKind === "primary") {
    const rows = db.prepare(`SELECT session_key, task_name FROM sessions
      WHERE work_item_id = ? AND role = 'leader' AND run_kind = 'primary'
        AND session_key <> ? ORDER BY run_number ASC`)
      .all(host.workItemId, host.id) as { session_key: string; task_name: string | null }[];
    for (const row of rows) {
      const saved = loadContinuitySnapshot(db, row.session_key);
      const name = saved?.continuity.canonicalTaskName === undefined
        ? row.task_name : saved.continuity.canonicalTaskName;
      if (!name) continue;
      host.continuity.canonicalTaskName = name;
      host.taskName = name;
      return;
    }
  }
  host.taskName = host.continuity.canonicalTaskName ?? deriveTaskName(prompt);
}
