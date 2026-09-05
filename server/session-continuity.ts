import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ImageAttachment } from "./session-host-types.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import { setSessionCanvasContext } from "./canvas-context-store.ts";
import { persistenceDb } from "./session-persist.ts";
import { inheritedUserDirectives, retainUserDirectives, userTextFromPrompt } from "../shared/handoff-text.ts";
import type { PrimaryRunConfig } from "./work-item-run-config.ts";

export interface SessionContinuity {
  directives: string[];
  /** Null is an unnamed task; undefined identifies snapshots predating canonical naming. */
  canonicalTaskName?: string | null;
  /** Undefined means never supplied; null is an explicit cleared snapshot. */
  canvasContext?: string | null;
  attachments?: ImageAttachment[];
}
export interface ContinuitySnapshot {
  continuity: SessionContinuity;
  skillIds: string[];
  skillSnapshotId?: string | undefined;
  skillValues: Record<string, Record<string, string>>;
}

export function captureSessionContinuity(host: SessionHost, opts: StartSessionOptions): void {
  if (host.role !== "leader" || opts.contextCheckpointId || opts.continuitySource === "system" || typeof opts.prompt !== "string") return;
  const text = userTextFromPrompt(opts.displayPrompt ?? opts.prompt);
  const inherited = host.continuity.directives.length ? []
    : opts.userDirectives ?? inheritedUserDirectives(opts.prompt);
  const incoming = [...inherited, text].filter(Boolean);
  host.continuity.directives = retainUserDirectives([...host.continuity.directives, ...incoming]);
  const connected = opts.prompt.match(/<connected-context>[\s\S]*?<\/connected-context>/)?.[0] ?? opts.planningContext;
  if (opts.attachments !== undefined) host.continuity.attachments = opts.attachments;
  if (connected) host.setCanvasContext(connected);
  const db = persistenceDb();
  if (db && incoming.length) db.transaction(() => {
    host.persist();
    for (const directive of incoming) {
      const hash = createHash("sha256").update(directive).digest("hex");
      const last = db.prepare("SELECT content_hash FROM session_user_directives WHERE session_key = ? ORDER BY id DESC LIMIT 1")
        .get(host.id) as { content_hash: string } | undefined;
      if (last?.content_hash !== hash) db.prepare(`INSERT INTO session_user_directives
        (session_key, content_hash, text) VALUES (?, ?, ?)`).run(host.id, hash, directive);
    }
  })();
}

export function saveContinuitySnapshot(db: Database.Database, host: SessionHost): void {
  const snapshot: ContinuitySnapshot = {
    continuity: host.continuity, skillIds: host.skillIds, skillValues: host.skillValues,
    skillSnapshotId: host.skillSnapshotId,
  };
  db.prepare(`INSERT INTO session_continuity (session_key, snapshot_json) VALUES (?, ?)
    ON CONFLICT(session_key) DO UPDATE SET snapshot_json = excluded.snapshot_json`)
    .run(host.id, JSON.stringify(snapshot));
}

export function loadContinuitySnapshot(db: Database.Database, key: string): ContinuitySnapshot | null {
  const row = db.prepare("SELECT snapshot_json FROM session_continuity WHERE session_key = ?")
    .get(key) as { snapshot_json: string } | undefined;
  return row ? JSON.parse(row.snapshot_json) as ContinuitySnapshot : null;
}

export function restoreSessionContinuity(host: SessionHost): void {
  const db = persistenceDb();
  if (!db) return;
  const saved = loadContinuitySnapshot(db, host.id);
  const row = db.prepare("SELECT run_config_json FROM sessions WHERE session_key = ?")
    .get(host.id) as { run_config_json?: string | null } | undefined;
  const config = row?.run_config_json ? JSON.parse(row.run_config_json) as PrimaryRunConfig : {};
  host.skillIds = saved?.skillIds ?? config.skillIds ?? [];
  host.skillSnapshotId = saved?.skillSnapshotId;
  host.skillValues = saved?.skillValues ?? config.skillValues ?? {};
  host.continuity = saved?.continuity ?? { directives: config.userDirectives ?? [],
    attachments: config.attachments, canvasContext: config.planningContext };
  // Older snapshots did not distinguish a fallback from a selected name.
  // Preserve their existing label; explicit null still permits first selection.
  if (host.continuity.canonicalTaskName === undefined) {
    host.continuity.canonicalTaskName = host.taskName;
  }
  if (host.continuity.canonicalTaskName) host.taskName = host.continuity.canonicalTaskName;
  // Hydration must not write a partially restored host back to disk.
  host.canvasContext = host.continuity.canvasContext !== undefined
    ? host.continuity.canvasContext : config.planningContext ?? null;
  setSessionCanvasContext(host.id, host.canvasContext);
}
