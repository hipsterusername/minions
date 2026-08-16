import type Database from "better-sqlite3";
import type { TaskGraphPlanSnapshotView } from
  "../../shared/task-graph-planning-contracts.ts";
import { safeArtifactReference } from "./artifact-access.ts";
import { readStoredTaskGraphArtifact } from "./artifact-store.ts";
import { TaskGraphValidationError } from "./errors.ts";

type Row = Record<string, unknown>;

export function readPlanningArtifact(db: Database.Database, plan: TaskGraphPlanSnapshotView,
  input: { artifactId: string; offset: number; maxBytes: number }): Record<string, unknown> {
  if (!plan.graphRunId) throw new TaskGraphValidationError("graph plan has no runtime artifacts");
  const row = db.prepare(`SELECT artifact.* FROM task_artifacts artifact
    JOIN task_node_attempts producer ON producer.id=artifact.producer_attempt_id
    WHERE artifact.id=? AND artifact.run_id=? AND artifact.state='committed'
    AND producer.runtime='terminal' AND producer.outcome='succeeded'
    AND NOT EXISTS (SELECT 1 FROM task_node_invalidations invalidation
      WHERE invalidation.run_id=artifact.run_id
      AND invalidation.invalidated_attempt_id=artifact.producer_attempt_id)
    AND NOT EXISTS (SELECT 1 FROM task_node_attempts newer
      WHERE newer.run_id=producer.run_id AND newer.node_id=producer.node_id
      AND newer.attempt_number>producer.attempt_number)`).get(
    input.artifactId, plan.graphRunId,
  ) as Row | undefined;
  if (!row) throw new TaskGraphValidationError("current committed graph artifact not found");
  const reference = safeArtifactReference(row);
  if (reference.classification === "secret") {
    throw new TaskGraphValidationError("secret artifacts cannot be copied into Leader context");
  }
  let metadata: Row;
  try { metadata = JSON.parse(String(row.metadata_json)) as Row; }
  catch { throw new TaskGraphValidationError("artifact metadata is invalid"); }
  if (typeof metadata.storageRef !== "string") {
    throw new TaskGraphValidationError("artifact storage is unavailable");
  }
  return { ...reference, ...readStoredTaskGraphArtifact({
    storageRef: metadata.storageRef,
    contentHash: reference.contentHash,
    byteSize: reference.byteSize,
    offset: input.offset,
    maxBytes: input.maxBytes,
  }) };
}
