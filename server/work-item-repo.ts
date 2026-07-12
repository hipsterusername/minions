import type Database from "better-sqlite3";
import { persistRunReport } from "./work-item-report-repo.ts";
import { syncResolutionToCurrentSession } from "./work-item-compat-repo.ts";
import {
  transitionWorkItemLifecycle,
  workItemLifecycleSchema,
  type ChangeMode,
  type IntegrationState,
  type Outcome,
  type Resolution,
  type RuntimeState,
  type WorkItemLifecycle,
  type WorkItemWaitKind,
} from "../shared/work-item-lifecycle.ts";
export interface WorkItemRow {
  id: string;
  project_id: string;
  project_path: string;
  title: string;
  runtime_state: RuntimeState;
  outcome: Outcome;
  resolution: Resolution;
  change_mode: ChangeMode;
  integration_state: IntegrationState;
  wait_kind: WorkItemWaitKind | null;
  current_run_key: string | null;
  iteration: number;
  workflow_column_id: string;
  workflow_rank: string;
  workflow_revision: number; kanban_json: string;
  lifecycle_revision: number;
  archived_from_resolution: Exclude<Resolution, "archived"> | null;
  last_transition_at: number;
  created_at: number;
  updated_at: number;
}
export interface WorkItemRunRow {
  session_key: string;
  work_item_id: string;
  run_number: number | null;
  run_kind: "primary" | "child";
  previous_run_key: string | null;
  parent_run_key: string | null;
  task_id: string | null;
  started_at: number;
  ended_at: number | null;
  run_outcome: Outcome;
  final_report_event_id: string | null;
  start_idempotency_key: string;
  session_id: string | null;
  final_report: string | null;
  provider_generation: number;
  run_config_json: string | null;
  harness_name: string; model: string | null;
}
export interface WorkItemBindingRow {
  work_item_id: string;
  surface: "canvas" | "kanban";
  binding_id: string;
  attached_at: number;
  detached_at: number | null;
}

export class WorkItemConflictError extends Error {
  constructor(
    message: string,
    readonly latest: WorkItemRow | null,
  ) {
    super(message);
    this.name = "WorkItemConflictError";
  }
}

function lifecycle(row: WorkItemRow): WorkItemLifecycle {
  return workItemLifecycleSchema.parse({
    runtimeState: row.runtime_state,
    outcome: row.outcome,
    resolution: row.resolution,
    changeMode: row.change_mode,
    integrationState: row.integration_state,
    lifecycleRevision: row.lifecycle_revision,
  });
}

function getRun(db: Database.Database, runKey: string): WorkItemRunRow | null {
  return (db.prepare(`
    SELECT session_key, work_item_id, run_number, run_kind, previous_run_key,
           parent_run_key, task_id, started_at,
           ended_at, run_outcome, final_report_event_id, start_idempotency_key,
           session_id, final_report, provider_generation, run_config_json, harness_name, model
    FROM sessions WHERE session_key = ? AND work_item_id IS NOT NULL
  `).get(runKey) as WorkItemRunRow | undefined) ?? null;
}

export const getWorkItemRun = getRun;
export function getWorkItem(db: Database.Database, id: string): WorkItemRow | null {
  return (db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItemRow | undefined) ?? null;
}

export function listWorkItemRuns(db: Database.Database, id: string): WorkItemRunRow[] {
  return db.prepare(`
    SELECT session_key, work_item_id, run_number, run_kind, previous_run_key,
           parent_run_key, task_id, started_at,
           ended_at, run_outcome, final_report_event_id, start_idempotency_key,
           session_id, final_report, provider_generation, run_config_json, harness_name, model
    FROM sessions WHERE work_item_id = ? ORDER BY run_number
  `).all(id) as WorkItemRunRow[];
}

export function createWorkItem(db: Database.Database, input: {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  changeMode: ChangeMode;
  workflowRank: string;
  workflowColumnId?: string;
  kanbanJson?: string;
  at: number;
  runConfigJson?: string | null;
}): WorkItemRow {
  const integrationState = input.changeMode === "live" ? "live_clean" : "worktree_unprovisioned";
  db.prepare(`
    INSERT INTO work_items (
      id, project_id, project_path, title, runtime_state, outcome, resolution,
      change_mode, integration_state, wait_kind, current_run_key, iteration,
      workflow_column_id, workflow_rank, workflow_revision, kanban_json, lifecycle_revision,
      last_transition_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'draft', 'none', 'open', ?, ?, NULL, NULL, 0, ?, ?, 0, ?, 0, ?, ?, ?)
  `).run(
    input.id, input.projectId, input.projectPath, input.title,
    input.changeMode, integrationState, input.workflowColumnId ?? "backlog",
    input.workflowRank, input.kanbanJson ?? "{}", input.at, input.at, input.at,
  );
  return getWorkItem(db, input.id)!;
}

function assertExpected(
  row: WorkItemRow | null,
  expectedRevision: number,
  expectedCurrentRunKey: string | null,
): asserts row is WorkItemRow {
  if (!row) throw new WorkItemConflictError("work item not found", null);
  if (row.lifecycle_revision !== expectedRevision || row.current_run_key !== expectedCurrentRunKey) {
    throw new WorkItemConflictError("stale work-item lifecycle", row);
  }
}

function writeLifecycle(
  db: Database.Database,
  row: WorkItemRow,
  next: WorkItemLifecycle,
  at: number,
  extra: {
    currentRunKey?: string;
    iteration?: number;
    waitKind?: WorkItemWaitKind | null;
    archivedFromResolution?: Exclude<Resolution, "archived">;
  } = {},
): void {
  const result = db.prepare(`
    UPDATE work_items SET
      runtime_state = ?, outcome = ?, resolution = ?, integration_state = ?,
      lifecycle_revision = ?, last_transition_at = ?, updated_at = ?,
      current_run_key = COALESCE(?, current_run_key),
      iteration = COALESCE(?, iteration),
      wait_kind = ?,
      archived_from_resolution = COALESCE(?, archived_from_resolution)
    WHERE id = ? AND lifecycle_revision = ? AND current_run_key IS ?
  `).run(
    next.runtimeState, next.outcome, next.resolution, next.integrationState,
    next.lifecycleRevision, at, at, extra.currentRunKey ?? null,
    extra.iteration ?? null, extra.waitKind ?? null,
    extra.archivedFromResolution ?? null, row.id,
    row.lifecycle_revision, row.current_run_key,
  );
  if (result.changes !== 1) throw new WorkItemConflictError("concurrent work-item mutation", getWorkItem(db, row.id));
}

export interface WorkItemMutationResult {
  workItem: WorkItemRow;
  run: WorkItemRunRow | null;
  idempotent: boolean;
}

export function startWorkItemIteration(db: Database.Database, input: {
  workItemId: string;
  runKey: string;
  idempotencyKey: string;
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string | null;
  at: number;
  runConfigJson?: string | null;
}): WorkItemMutationResult {
  if (!input.idempotencyKey) throw new Error("idempotencyKey is required");
  return db.transaction(() => {
    const duplicate = db.prepare(`
      SELECT session_key, work_item_id, run_number, run_kind, previous_run_key,
             parent_run_key, task_id, started_at,
             ended_at, run_outcome, final_report_event_id, start_idempotency_key,
             session_id, final_report, provider_generation, run_config_json, harness_name, model
      FROM sessions WHERE work_item_id = ? AND start_idempotency_key = ?
    `).get(input.workItemId, input.idempotencyKey) as WorkItemRunRow | undefined;
    if (duplicate) {
      return { workItem: getWorkItem(db, input.workItemId)!, run: duplicate, idempotent: true };
    }

    const row = getWorkItem(db, input.workItemId);
    assertExpected(row, input.expectedLifecycleRevision, input.expectedCurrentRunKey);
    const next = transitionWorkItemLifecycle(lifecycle(row), { type: "start_iteration" });
    const runNumber = row.iteration + 1;
    const iso = new Date(input.at).toISOString();
    db.prepare(`
      INSERT INTO sessions (
        session_key, project_id, status, cwd, role, task_name,
        work_item_id, run_number, run_kind, previous_run_key, parent_run_key,
        task_id, started_at, ended_at,
        run_outcome, final_report_event_id, start_idempotency_key, run_config_json, created_at, updated_at
      ) VALUES (?, ?, 'idle', ?, 'leader', ?, ?, ?, 'primary', ?, NULL, NULL, ?, NULL, 'none', NULL, ?, ?, ?, ?)
    `).run(
      input.runKey, row.project_id, row.project_path, row.title, row.id,
      runNumber, row.current_run_key, input.at, input.idempotencyKey, input.runConfigJson ?? null, iso, iso,
    );
    writeLifecycle(db, row, next, input.at, {
      currentRunKey: input.runKey,
      iteration: runNumber,
      waitKind: null,
    });
    return {
      workItem: getWorkItem(db, row.id)!,
      run: getRun(db, input.runKey),
      idempotent: false,
    };
  }).immediate();
}

export function waitWorkItemRun(db: Database.Database, input: {
  workItemId: string;
  runKey: string;
  waitKind: WorkItemWaitKind;
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string;
  at: number;
}): WorkItemMutationResult {
  return db.transaction(() => {
    const row = getWorkItem(db, input.workItemId);
    assertExpected(row, input.expectedLifecycleRevision, input.expectedCurrentRunKey);
    const run = getRun(db, input.runKey);
    if (!run || run.run_kind !== "primary" || run.ended_at !== null
      || row.current_run_key !== run.session_key) {
      throw new WorkItemConflictError("run is not the current open primary", row);
    }
    const next = transitionWorkItemLifecycle(lifecycle(row), { type: "wait" });
    writeLifecycle(db, row, next, input.at, { waitKind: input.waitKind });
    return { workItem: getWorkItem(db, row.id)!, run: getRun(db, run.session_key), idempotent: false };
  }).immediate();
}

export function resumeWaitingWorkItemRun(db: Database.Database, input: {
  workItemId: string;
  runKey: string;
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string;
  at: number;
}): WorkItemMutationResult {
  return db.transaction(() => {
    const row = getWorkItem(db, input.workItemId);
    assertExpected(row, input.expectedLifecycleRevision, input.expectedCurrentRunKey);
    const run = getRun(db, input.runKey);
    if (!run || run.run_kind !== "primary" || run.ended_at !== null
      || row.current_run_key !== run.session_key) {
      throw new WorkItemConflictError("run is not the current open primary", row);
    }
    const next = transitionWorkItemLifecycle(lifecycle(row), { type: "resume" });
    writeLifecycle(db, row, next, input.at, { waitKind: null });
    db.prepare(`UPDATE sessions SET review_state = 'none', review_reason = NULL,
      acknowledged_at = NULL, dismissed_at = NULL, updated_at = ?
      WHERE session_key = ? AND work_item_id = ?`)
      .run(new Date(input.at).toISOString(), input.runKey, input.workItemId);
    return { workItem: getWorkItem(db, row.id)!, run: getRun(db, run.session_key), idempotent: false };
  }).immediate();
}

export function sealWorkItemRun(db: Database.Database, input: {
  workItemId: string;
  runKey: string;
  outcome: Exclude<Outcome, "none">;
  finalReportEventId?: string | null;
  finalReport?: string | null;
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string;
  at: number;
}): WorkItemMutationResult {
  if (input.outcome === "completed" && (!input.finalReportEventId?.trim() || !input.finalReport?.trim()))
    throw new Error("completed runs require a durable final report event and content");
  return db.transaction(() => {
    if (input.outcome === "completed") persistRunReport(db, { id: input.finalReportEventId!,
      workItemId: input.workItemId, runKey: input.runKey, text: input.finalReport!, at: input.at });
    const existingRun = getRun(db, input.runKey);
    if (!existingRun || existingRun.work_item_id !== input.workItemId) {
      throw new WorkItemConflictError("run does not belong to work item", getWorkItem(db, input.workItemId));
    }
    const effectiveOutcome = input.outcome === "completed" && !input.finalReportEventId
      ? "interrupted"
      : input.outcome;
    if (existingRun.ended_at !== null) {
      if (existingRun.run_outcome !== effectiveOutcome
        || existingRun.final_report_event_id !== (input.finalReportEventId ?? null)
        || existingRun.final_report !== (input.finalReport ?? null)) {
        throw new Error("terminal run outcome and report are immutable");
      }
      return { workItem: getWorkItem(db, input.workItemId)!, run: existingRun, idempotent: true };
    }

    const row = getWorkItem(db, input.workItemId);
    assertExpected(row, input.expectedLifecycleRevision, input.expectedCurrentRunKey);
    if (row.current_run_key !== input.runKey) throw new WorkItemConflictError("run is not current", row);
    const next = transitionWorkItemLifecycle(lifecycle(row), {
      type: "seal",
      outcome: input.outcome,
      hasFinalReport: Boolean(input.finalReportEventId),
    });
    const sealed = db.prepare(`
      UPDATE sessions SET ended_at = ?, run_outcome = ?, final_report_event_id = ?, final_report = ?, updated_at = ?
      WHERE session_key = ? AND ended_at IS NULL AND run_outcome = 'none'
    `).run(input.at, next.outcome, input.finalReportEventId ?? null,
      input.finalReport ?? null, new Date(input.at).toISOString(), input.runKey);
    if (sealed.changes !== 1) throw new Error("run was concurrently sealed");
    writeLifecycle(db, row, next, input.at, { waitKind: null });
    return { workItem: getWorkItem(db, row.id)!, run: getRun(db, input.runKey), idempotent: false };
  }).immediate();
}

function resolveWorkItem(db: Database.Database, input: {
  workItemId: string;
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string | null;
  at: number;
}, event: "review" | "archive"): WorkItemMutationResult {
  return db.transaction(() => {
    const row = getWorkItem(db, input.workItemId);
    assertExpected(row, input.expectedLifecycleRevision, input.expectedCurrentRunKey);
    const next = transitionWorkItemLifecycle(lifecycle(row), { type: event });
    writeLifecycle(db, row, next, input.at, {
      waitKind: row.wait_kind,
      ...(event === "archive"
        ? { archivedFromResolution: row.resolution as Exclude<Resolution, "archived"> }
        : {}),
    });
    syncResolutionToCurrentSession(db, { runKey: row.current_run_key, workItemId: row.id,
      action: event, lifecycleRevision: next.lifecycleRevision, at: input.at });
    const latest = getWorkItem(db, row.id)!;
    return { workItem: latest, run: latest.current_run_key ? getRun(db, latest.current_run_key) : null, idempotent: false };
  }).immediate();
}

export const reviewWorkItem = (
  db: Database.Database,
  input: Parameters<typeof resolveWorkItem>[1],
): WorkItemMutationResult => resolveWorkItem(db, input, "review");

export const archiveWorkItem = (
  db: Database.Database,
  input: Parameters<typeof resolveWorkItem>[1],
): WorkItemMutationResult => resolveWorkItem(db, input, "archive");

export function restoreWorkItem(db: Database.Database, input: {
  workItemId: string;
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string | null;
  at: number;
}): WorkItemMutationResult {
  return db.transaction(() => {
    const row = getWorkItem(db, input.workItemId);
    assertExpected(row, input.expectedLifecycleRevision, input.expectedCurrentRunKey);
    if (row.resolution !== "archived") throw new WorkItemConflictError("work item is not archived", row);
    if (row.archived_from_resolution === null) {
      throw new WorkItemConflictError("archived work item is missing prior resolution", row);
    }
    const resolution = row.archived_from_resolution;
    const next = workItemLifecycleSchema.parse({
      ...lifecycle(row),
      resolution,
      lifecycleRevision: row.lifecycle_revision + 1,
    });
    const changed = db.prepare(`
      UPDATE work_items SET resolution = ?, lifecycle_revision = ?,
        last_transition_at = ?, updated_at = ?, archived_from_resolution = NULL
      WHERE id = ? AND lifecycle_revision = ? AND current_run_key IS ?
    `).run(resolution, next.lifecycleRevision, input.at, input.at, row.id,
      row.lifecycle_revision, row.current_run_key);
    if (changed.changes !== 1) {
      throw new WorkItemConflictError("concurrent work-item mutation", getWorkItem(db, row.id));
    }
    syncResolutionToCurrentSession(db, { runKey: row.current_run_key, workItemId: row.id,
      action: "restore", lifecycleRevision: next.lifecycleRevision, at: input.at });
    const latest = getWorkItem(db, row.id)!;
    return { workItem: latest, run: latest.current_run_key ? getRun(db, latest.current_run_key) : null, idempotent: false };
  }).immediate();
}
