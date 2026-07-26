import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  projectLegacySessionLifecycle,
  workItemLifecycleSchema,
  type IntegrationState,
  type LegacySessionReviewLifecycle,
  type LegacySessionStatus,
  type Resolution,
} from "../shared/work-item-lifecycle.ts";

interface LegacySessionRow {
  session_key: string;
  project_id: string | null;
  status: string;
  cwd: string | null;
  role: string;
  task_name: string | null;
  worktree_isolation: number;
  worktree_project_path: string | null;
  worktree_lifecycle: string | null;
  review_state: LegacySessionReviewLifecycle["reviewState"];
  review_reason: string | null;
  final_report: string | null;
  terminal_reason: LegacySessionReviewLifecycle["terminalReason"];
  terminal_at: number | null;
  acknowledged_at: number | null;
  dismissed_at: number | null;
  lifecycle_revision: number;
  created_at: string;
  updated_at: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function legacyWorkItemId(sessionKey: string): string {
  return `legacy-work-${digest(sessionKey)}`;
}

export function legacyProjectIdentity(
  projectId: string | null,
  cwd: string | null,
  worktreeProjectPath: string | null,
): { projectId: string; projectPath: string } {
  const projectPath = path.normalize(path.resolve(worktreeProjectPath || cwd || process.cwd()));
  return {
    projectId: projectId?.trim() || `legacy-project-${digest(projectPath)}`,
    projectPath,
  };
}

function timestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function legacyStatus(value: string): LegacySessionStatus {
  if (["creating", "running", "waiting", "idle", "stopped", "error", "completed", "disconnected"].includes(value)) {
    return value as LegacySessionStatus;
  }
  return "disconnected";
}

function integration(row: LegacySessionRow): IntegrationState {
  if (row.worktree_isolation !== 1) return "live_clean";
  return row.worktree_lifecycle === "active" ? "worktree_active" : "worktree_unprovisioned";
}

function review(row: LegacySessionRow): LegacySessionReviewLifecycle {
  return {
    reviewState: row.review_state ?? "none",
    finalReport: row.final_report,
    terminalReason: row.terminal_reason,
    acknowledgedAt: row.acknowledged_at,
    dismissedAt: row.dismissed_at,
    lifecycleRevision: row.lifecycle_revision ?? 0,
  };
}

function reliableTerminalSnapshot(row: LegacySessionRow, outcome: "completed" | "error" | "interrupted"): boolean {
  if (row.terminal_at === null) return false;
  if (outcome === "completed") {
    return row.review_state === "completion_to_review"
      && row.terminal_reason === "completed" && Boolean(row.final_report?.trim());
  }
  if (outcome === "error") {
    return row.review_state === "error_to_review" && row.terminal_reason === "error";
  }
  return row.review_state === "interrupted_to_review"
    && (row.terminal_reason === "stop" || row.terminal_reason === "abort");
}

function normalizedTerminalFields(
  row: LegacySessionRow,
  outcome: "completed" | "error" | "interrupted",
  terminalAt: number,
): {
  reviewState: LegacySessionReviewLifecycle["reviewState"];
  reviewReason: string;
  terminalReason: Exclude<LegacySessionReviewLifecycle["terminalReason"], null>;
  terminalAt: number;
} {
  if (outcome === "completed") {
    return {
      reviewState: "completion_to_review",
      reviewReason: "Read the final report and review the dashboard",
      terminalReason: "completed",
      terminalAt,
    };
  }
  if (outcome === "error") {
    return {
      reviewState: "error_to_review",
      reviewReason: "Session ended with an error",
      terminalReason: "error",
      terminalAt,
    };
  }
  return {
    reviewState: "interrupted_to_review",
    reviewReason: "Session became inactive without a final report",
    terminalReason: row.status === "stopped" || row.terminal_reason === "stop" ? "stop" : "abort",
    terminalAt,
  };
}

export interface LegacyBackfillResult {
  workItemIds: string[];
  skippedSessionKeys: string[];
}

/** Backfill each unbound legacy leader/default session as immutable primary run 1. */
export function backfillLegacyWorkItems(
  db: Database.Database,
  at: number = Date.now(),
): LegacyBackfillResult {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM sessions
      WHERE work_item_id IS NULL AND role IN ('leader', 'default')
      ORDER BY created_at, session_key
    `).all() as LegacySessionRow[];
    const workItemIds: string[] = [];
    const skippedSessionKeys: string[] = [];

    for (const row of rows) {
      const status = legacyStatus(row.status);
      const changeMode = row.worktree_isolation === 1 ? "worktree" : "live";
      const projected = projectLegacySessionLifecycle({
        status,
        reviewLifecycle: review(row),
        changeMode,
        integrationState: integration(row),
      });
      // A legacy idle row with no durable outcome is ambiguous. It is never
      // evidence of completion; preserve it as interrupted history.
      const conservativeOutcome = status === "idle" && projected.lifecycle.runtimeState === "inactive"
        && projected.lifecycle.outcome === "none"
        ? "interrupted"
        : projected.lifecycle.outcome;
      const terminal = conservativeOutcome !== "none";
      const correctedTerminal = terminal && !reliableTerminalSnapshot(
        row,
        conservativeOutcome as "completed" | "error" | "interrupted",
      );
      const canonicalLifecycle = workItemLifecycleSchema.parse({
        ...projected.lifecycle,
        runtimeState: terminal ? "inactive" : projected.lifecycle.runtimeState,
        outcome: conservativeOutcome,
        lifecycleRevision: projected.lifecycle.lifecycleRevision + (correctedTerminal ? 1 : 0),
      });
      const itemId = legacyWorkItemId(row.session_key);
      const project = legacyProjectIdentity(row.project_id, row.cwd, row.worktree_project_path);
      const createdAt = timestamp(row.created_at, at);
      const updatedAt = timestamp(row.updated_at, at);
      const endedAt = terminal ? (row.terminal_at ?? updatedAt) : null;
      const normalized = correctedTerminal
        ? normalizedTerminalFields(
            row,
            canonicalLifecycle.outcome as "completed" | "error" | "interrupted",
            endedAt!,
          )
        : null;
      const archivedFrom: Exclude<Resolution, "archived"> | null =
        canonicalLifecycle.resolution === "archived"
          ? (row.acknowledged_at !== null ? "reviewed" : "open")
          : null;

      const existing = db.prepare(`
        SELECT project_id, project_path, title, runtime_state, outcome, resolution,
          change_mode, integration_state, wait_kind, current_run_key, iteration
        FROM work_items WHERE id = ?
      `).get(itemId) as Record<string, unknown> | undefined;
      if (existing) {
        const expected = {
          project_id: project.projectId, project_path: project.projectPath,
          title: row.task_name?.trim() || "Recovered session",
          runtime_state: canonicalLifecycle.runtimeState, outcome: canonicalLifecycle.outcome,
          resolution: canonicalLifecycle.resolution, change_mode: changeMode,
          integration_state: canonicalLifecycle.integrationState, wait_kind: projected.waitKind,
          current_run_key: row.session_key, iteration: 1,
        };
        const mismatch = Object.entries(expected).find(([key, value]) => existing[key] !== value);
        if (mismatch) {
          throw new Error(`legacy work-item id collision for ${row.session_key}: ${mismatch[0]} does not match`);
        }
        const owner = db.prepare(
          "SELECT session_key FROM sessions WHERE work_item_id = ? AND session_key <> ? LIMIT 1",
        ).get(itemId, row.session_key);
        if (owner) throw new Error(`legacy work-item id collision for ${row.session_key}: item already owns another session`);
      }

      if (!existing) db.prepare(`
        INSERT INTO work_items (
          id, project_id, project_path, title, runtime_state, outcome, resolution,
          change_mode, integration_state, wait_kind, archived_from_resolution,
          current_run_key, iteration, workflow_column_id, workflow_rank,
          lifecycle_revision, last_transition_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'backlog', ?, ?, ?, ?, ?)
      `).run(
        itemId, project.projectId, project.projectPath,
        row.task_name?.trim() || "Recovered session",
        canonicalLifecycle.runtimeState, canonicalLifecycle.outcome, canonicalLifecycle.resolution,
        changeMode, canonicalLifecycle.integrationState, projected.waitKind,
        archivedFrom, row.session_key,
        `${String(createdAt).padStart(16, "0")}:${row.session_key}`,
        canonicalLifecycle.lifecycleRevision, normalized?.terminalAt ?? row.terminal_at ?? updatedAt,
        createdAt, updatedAt,
      );
      db.prepare(`
        UPDATE sessions SET
          project_id = COALESCE(project_id, ?), work_item_id = ?, run_number = 1,
          run_kind = 'primary', previous_run_key = NULL, parent_run_key = NULL,
          task_id = NULL, started_at = ?, ended_at = ?, run_outcome = ?,
          start_idempotency_key = ?,
          review_state = ?, review_reason = ?, terminal_reason = ?, terminal_at = ?,
          lifecycle_revision = ?
        WHERE session_key = ? AND work_item_id IS NULL
      `).run(
        project.projectId, itemId, createdAt, endedAt,
        canonicalLifecycle.outcome, `legacy-backfill:${row.session_key}`,
        normalized?.reviewState ?? row.review_state,
        normalized?.reviewReason ?? row.review_reason,
        normalized?.terminalReason ?? row.terminal_reason,
        normalized?.terminalAt ?? row.terminal_at,
        canonicalLifecycle.lifecycleRevision,
        row.session_key,
      );
      workItemIds.push(itemId);
    }
    return { workItemIds, skippedSessionKeys };
  }).immediate();
}

export interface BootRecoveryResult {
  recoveredRunKeys: string[];
  repairedCompletedRunKeys?: string[];
}

export { repairCompletedRunsWithoutReports } from "./work-item-report-repair.ts";

/** Seal orphaned active primary runs once; live run keys are left untouched. */
export function recoverOrphanedWorkItemRuns(
  db: Database.Database,
  liveRunKeys: ReadonlySet<string> = new Set(),
  at: number = Date.now(),
): BootRecoveryResult {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT w.id, w.current_run_key, w.lifecycle_revision
      FROM work_items w
      JOIN sessions s ON s.session_key = w.current_run_key
      WHERE w.runtime_state IN ('starting', 'working', 'waiting')
        AND w.outcome = 'none' AND s.run_kind = 'primary'
        AND s.ended_at IS NULL AND s.run_outcome = 'none'
      ORDER BY w.id
    `).all() as Array<{ id: string; current_run_key: string; lifecycle_revision: number }>;
    const recoveredRunKeys: string[] = [];

    for (const row of rows) {
      if (liveRunKeys.has(row.current_run_key)) continue;
      const sealed = db.prepare(`
        UPDATE sessions SET ended_at = ?, run_outcome = 'interrupted', status = 'stopped',
          review_state = 'interrupted_to_review',
          review_reason = 'Session became inactive without a final report',
          terminal_reason = 'abort', terminal_at = ?,
          acknowledged_at = NULL, dismissed_at = NULL,
          lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE session_key = ? AND run_kind = 'primary'
          AND ended_at IS NULL AND run_outcome = 'none'
      `).run(at, at, new Date(at).toISOString(), row.current_run_key);
      if (sealed.changes !== 1) continue;
      const projected = db.prepare(`
        UPDATE work_items SET runtime_state = 'inactive', outcome = 'interrupted',
          resolution = 'open', wait_kind = NULL,
          lifecycle_revision = lifecycle_revision + 1,
          last_transition_at = ?, updated_at = ?
        WHERE id = ? AND current_run_key = ? AND lifecycle_revision = ?
          AND runtime_state IN ('starting', 'working', 'waiting') AND outcome = 'none'
      `).run(at, at, row.id, row.current_run_key, row.lifecycle_revision);
      if (projected.changes !== 1) throw new Error(`failed to recover work item ${row.id}`);
      recoveredRunKeys.push(row.current_run_key);
    }

    const children = db.prepare(`
      SELECT session_key, parent_run_key, task_id
      FROM sessions
      WHERE work_item_id IS NOT NULL AND run_kind = 'child'
        AND ended_at IS NULL AND run_outcome = 'none'
      ORDER BY session_key
    `).all() as Array<{
      session_key: string;
      parent_run_key: string;
      task_id: string;
    }>;
    for (const child of children) {
      if (liveRunKeys.has(child.session_key)) continue;
      const sealed = db.prepare(`
        UPDATE sessions SET ended_at = ?, run_outcome = 'interrupted', status = 'stopped',
          review_state = 'interrupted_to_review',
          review_reason = 'Session became inactive without a final report',
          terminal_reason = 'abort', terminal_at = ?,
          acknowledged_at = NULL, dismissed_at = NULL,
          lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE session_key = ? AND run_kind = 'child'
          AND ended_at IS NULL AND run_outcome = 'none'
      `).run(at, at, new Date(at).toISOString(), child.session_key);
      if (sealed.changes !== 1) continue;
      db.prepare(`
        UPDATE task_records SET status = 'orphaned',
          result = 'Delegated run was orphaned during server restart.', completed_at = ?
        WHERE leader_session_key = ? AND task_id = ?
          AND minion_session_key = ? AND status IN ('starting', 'running', 'blocked')
      `).run(at, child.parent_run_key, child.task_id, child.session_key);
      recoveredRunKeys.push(child.session_key);
    }
    return { recoveredRunKeys };
  }).immediate();
}
