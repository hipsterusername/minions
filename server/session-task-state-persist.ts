/** Durable serialization for the complete Leader task workflow snapshot. */

import type Database from "better-sqlite3";
import * as repo from "./session-repo.ts";
import type {
  ApprovalState,
  TaskManagerState,
  TaskRecord,
} from "./task-tools.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("session-persist");

export function persistLeaderTaskState(
  db: Database.Database,
  leaderSessionKey: string,
  state: TaskManagerState,
): void {
  freezeLegacyWaitCohort(state);
  db.transaction(() => {
    const currentIds = new Set(state.tasks.keys());
    const existing = repo.getTaskRecordsForLeader(db, leaderSessionKey);
    for (const row of existing) {
      if (!currentIds.has(row.taskId)) {
        repo.deleteTaskRecord(db, leaderSessionKey, row.taskId);
      }
    }
    for (const record of state.tasks.values()) repo.upsertTaskRecord(db, record);
    repo.updateSessionApproval(db, leaderSessionKey, state.approval);
    const snapshot = {
      tasks: Array.from(state.tasks.values()),
      pendingWait: state.pendingWait
        ? { ...state.pendingWait, timerId: null }
        : null,
      approval: state.approval,
    };
    const write = db.prepare(
      "UPDATE sessions SET task_state_json = ?, updated_at = ? WHERE session_key = ?",
    ).run(JSON.stringify(snapshot), new Date().toISOString(), leaderSessionKey);
    if (write.changes !== 1) {
      throw new Error(`Cannot persist task state for missing leader session ${leaderSessionKey}`);
    }
  })();
}

export function hydrateLeaderTaskState(
  db: Database.Database,
  row: {
    session_key: string;
    approval_json: string | null;
    task_state_json?: string | null;
  },
): TaskManagerState {
  const approval = parseApproval(row.approval_json);
  if (row.task_state_json) {
    try {
      const snapshot = JSON.parse(row.task_state_json) as {
        tasks?: TaskRecord[];
        pendingWait?: TaskManagerState["pendingWait"];
        approval?: ApprovalState | null;
      };
      const records = Array.isArray(snapshot.tasks)
        ? snapshot.tasks.map(normalizeTaskRecord)
        : [];
      const state: TaskManagerState = {
        tasks: new Map(records.map((record) => [record.taskId, record])),
        pendingWait: snapshot.pendingWait
          ? { ...snapshot.pendingWait, timerId: null }
          : null,
        approval: snapshot.approval ?? approval,
      };
      freezeLegacyWaitCohort(state);
      return state;
    } catch (error) {
      log.warn("task_state_snapshot_load_failed", {
        sessionKey: row.session_key,
        error,
      });
    }
  }
  const records = repo.getTaskRecordsForLeader(db, row.session_key).map(normalizeTaskRecord);
  return {
    tasks: new Map(records.map((record) => [record.taskId, record])),
    pendingWait: null,
    approval,
  };
}

function normalizeTaskRecord(record: TaskRecord): TaskRecord {
  if (record.executor !== "minion" || !record.minionSessionKey) return record;
  const generation = record.attemptGeneration ?? record.attempt ?? 1;
  return {
    ...record,
    attempt: record.attempt ?? generation,
    attemptGeneration: generation,
    attemptId:
      record.attemptId ??
      `legacy:${record.leaderSessionKey}:${record.taskId}:${generation}:${record.minionSessionKey}`,
  };
}

function freezeLegacyWaitCohort(state: TaskManagerState): void {
  const wait = state.pendingWait;
  if (!wait || wait.taskIds) return;
  wait.taskIds = Array.from(state.tasks.values())
    .filter((task) => task.executor === "minion" && (
      !isTerminalStatus(task.status) ||
      (task.completedAt != null && task.completedAt >= wait.scheduledAt)
    ))
    .map((task) => task.taskId)
    .sort();
}

function isTerminalStatus(status: TaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" ||
    status === "ended_without_report" || status === "cancelled" || status === "orphaned";
}

function parseApproval(value: string | null): ApprovalState | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ApprovalState;
  } catch {
    return null;
  }
}
