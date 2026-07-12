import {
  workItemRunSnapshotSchema,
  workItemSnapshotSchema,
  type WorkItemBindingSnapshot,
  type WorkItemRunSnapshot,
  type WorkItemSnapshot,
} from "../shared/work-item-contracts.ts";
import type { WorkItemBindingRow, WorkItemRow, WorkItemRunRow } from "./work-item-repo.ts";
import { kanbanCardMetadataSchema } from "../shared/work-item-kanban.ts";

export function itemSnapshot(row: WorkItemRow): WorkItemSnapshot {
  return workItemSnapshotSchema.parse({
    id: row.id, projectId: row.project_id, projectPath: row.project_path,
    title: row.title,
    lifecycle: { runtimeState: row.runtime_state, outcome: row.outcome,
      resolution: row.resolution, changeMode: row.change_mode,
      integrationState: row.integration_state, lifecycleRevision: row.lifecycle_revision },
    waitKind: row.wait_kind, currentRunKey: row.current_run_key,
    iteration: row.iteration, workflowColumnId: row.workflow_column_id,
    workflowRank: row.workflow_rank, lastTransitionAt: row.last_transition_at,
    workflowRevision: row.workflow_revision,
    card: kanbanCardMetadataSchema.parse(JSON.parse(row.kanban_json)),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

export function runSnapshot(row: WorkItemRunRow): WorkItemRunSnapshot {
  return workItemRunSnapshotSchema.parse({
    runKey: row.session_key, workItemId: row.work_item_id, runKind: row.run_kind,
    parentRunKey: row.parent_run_key, taskId: row.task_id, runNumber: row.run_number,
    previousRunKey: row.previous_run_key, providerSessionId: row.session_id,
    outcome: row.run_outcome, startedAt: row.started_at, endedAt: row.ended_at,
    finalReport: row.final_report,
  });
}

export function bindingSnapshot(row: WorkItemBindingRow): WorkItemBindingSnapshot {
  return { workItemId: row.work_item_id, surface: row.surface,
    bindingId: row.binding_id, attachedAt: row.attached_at, detachedAt: row.detached_at };
}
