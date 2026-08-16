import type Database from "better-sqlite3";
import {
  leaderOrchestrationModeSchema,
  type LeaderOrchestrationMode,
} from "../../shared/task-graph-planning-contracts.ts";
import {
  DEFAULT_LEADER_PLANNING_BACKEND,
  defaultOrchestrationModeForBackend,
} from "../../shared/leader-planning.ts";

const DEFAULT_CANONICAL_ORCHESTRATION_MODE = defaultOrchestrationModeForBackend(
  DEFAULT_LEADER_PLANNING_BACKEND,
);

export function leaderOrchestrationModeForRun(
  db: Database.Database,
  runKey: string,
): LeaderOrchestrationMode {
  const row = db.prepare("SELECT run_config_json FROM sessions WHERE session_key=?")
    .get(runKey) as { run_config_json: string | null } | undefined;
  if (!row?.run_config_json) return DEFAULT_CANONICAL_ORCHESTRATION_MODE;
  try {
    const value = (JSON.parse(row.run_config_json) as Record<string, unknown>)["orchestrationMode"];
    const parsed = leaderOrchestrationModeSchema.safeParse(value);
    return parsed.success ? parsed.data : DEFAULT_CANONICAL_ORCHESTRATION_MODE;
  } catch { return DEFAULT_CANONICAL_ORCHESTRATION_MODE; }
}

export function planningContextForRun(db: Database.Database, runKey: string): string | null {
  const row = db.prepare("SELECT run_config_json FROM sessions WHERE session_key=?")
    .get(runKey) as { run_config_json: string | null } | undefined;
  if (!row?.run_config_json) return null;
  try {
    const value = (JSON.parse(row.run_config_json) as Record<string, unknown>)["planningContext"];
    return typeof value === "string" && value.trim() ? value : null;
  } catch { return null; }
}
