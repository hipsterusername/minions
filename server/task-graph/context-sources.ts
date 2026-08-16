import type Database from "better-sqlite3";
import type { ScopedContextSource } from "./planning-source.ts";
import { TaskGraphConflictError } from "./errors.ts";
import { assertPlanningContextLimits } from "./planning-context-limits.ts";

type Row = Record<string, unknown>;

export function storeScopedContextSources(
  db: Database.Database,
  sources: ScopedContextSource[],
  at: number,
): void {
  assertPlanningContextLimits(sources);
  const statement = db.prepare(`INSERT OR IGNORE INTO task_graph_context_sources
    (source_snapshot_id,node_id,source_id,content_hash,classification,content,created_at)
    VALUES (?,?,?,?,?,?,?)`);
  const lookup = db.prepare(`SELECT content_hash,content FROM task_graph_context_sources
    WHERE source_snapshot_id=? AND node_id=? AND source_id=?`);
  db.transaction(() => {
    for (const source of sources) {
      statement.run(source.sourceSnapshotId, source.nodeId, source.sourceId,
        source.contentHash, source.classification, source.content, at);
      const row = lookup.get(source.sourceSnapshotId, source.nodeId, source.sourceId) as Row;
      if (row.content_hash !== source.contentHash || row.content !== source.content) {
        throw new TaskGraphConflictError("task context source is immutable");
      }
    }
  }).immediate();
}

export function scopedContextForNode(
  db: Database.Database,
  sourceSnapshotId: string,
  nodeId: string,
): Array<{ sourceId: string; contentHash: string; classification: string; content: string }> {
  return (db.prepare(`SELECT source_id,content_hash,classification,content
    FROM task_graph_context_sources WHERE source_snapshot_id=? AND node_id=? ORDER BY source_id`)
    .all(sourceSnapshotId, nodeId) as Row[]).map((row) => ({
    sourceId: String(row.source_id),
    contentHash: String(row.content_hash),
    classification: String(row.classification),
    content: String(row.content),
  }));
}
