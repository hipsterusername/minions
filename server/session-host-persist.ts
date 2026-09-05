import type { SessionHost } from "./session-host.ts";
import { saveContinuitySnapshot } from "./session-continuity.ts";
import { persistenceDb, persistSession, type PersistableSession } from "./session-persist.ts";

/** The durable host snapshot is committed as a single persistence transaction. */
export function persistHostSnapshot(host: SessionHost): void {
    const snap: PersistableSession = {
      id: host.id,
      status: host.status,
      cwd: host.cwd,
      model: host.model,
      role: host.role,
      taskName: host.taskName,
      sessionId: host.sessionId,
      worktreeIsolation: host.worktreeIsolation,
      worktree: host.worktree,
      approval: host.taskState?.approval ?? null,
      totalCost: host.totalCost,
      turns: host.turns,
      harnessName: host.harnessName,
      permissionMode: host.permissionMode,
      sandboxPolicy: host.sandboxPolicy,
      reviewLifecycle: host.reviewLifecycle,
    };
    const db = persistenceDb();
    if (!db) { persistSession(snap); return; }
    db.transaction(() => { persistSession(snap); saveContinuitySnapshot(db, host); })();
}
