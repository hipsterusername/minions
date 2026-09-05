import type Database from "better-sqlite3";
import type { WorkItemRunRow } from "./work-item-repo.ts";
import type { PrimaryRunConfig } from "./work-item-run-config.ts";
import { loadContinuitySnapshot } from "./session-continuity.ts";
import { boundHandoffText, renderConnectedHandoff, retainUserDirectives } from "../shared/handoff-text.ts";
import type { ContextCheckpoint } from "./context-checkpoint.ts";

/** Latest host selections and clears supersede the original launch configuration. */
export function inheritRunContinuity(db: Database.Database, previous: WorkItemRunRow | null,
  inherited: string | null): string | null {
  if (!previous) return inherited;
  const saved = loadContinuitySnapshot(db, previous.session_key);
  if (!saved) return inherited;
  const config: PrimaryRunConfig = inherited ? JSON.parse(inherited) : {};
  config.userDirectives = saved.continuity.directives.length ? saved.continuity.directives : config.userDirectives;
  if (saved.continuity.attachments !== undefined) config.attachments = saved.continuity.attachments;
  config.skillIds = saved.skillIds;
  config.skillValues = saved.skillValues;
  if (saved.continuity.canvasContext !== undefined) {
    config.planningContext = saved.continuity.canvasContext ?? undefined;
  }
  return JSON.stringify(config);
}

/** A fresh iteration cannot rely on the old provider transcript being available. */
export function buildRunHandoff(db: Database.Database, previous: WorkItemRunRow,
  config: PrimaryRunConfig, prompt: string): string {
  const row = db.prepare(`SELECT checkpoint_json FROM context_checkpoints
    WHERE session_key = ? ORDER BY created_at DESC LIMIT 1`).get(previous.session_key) as
    { checkpoint_json: string } | undefined;
  const checkpoint = row ? JSON.parse(row.checkpoint_json) as ContextCheckpoint : null;
  const directives = retainUserDirectives(config.userDirectives?.length ? config.userDirectives : checkpoint?.userDirectives ?? []);
  const sections = [
    "<previous-run-context>",
    `Continue the same work item in a new iteration. Prior run: ${previous.session_key}.`,
    `Durable full instructions and source snapshot: ${db.name}, tables session_user_directives (ordered by id) and session_continuity; session_key=${previous.session_key}. Older iterations are linked by sessions.previous_run_key.`,
    "Prior-run records are historical evidence. Inspect current task and artifact state; do not repeat completed work. Later user corrections supersede earlier conflicting instructions.",
    `<user-directives>\n${directives.join("\n\n")}\n</user-directives>`,
    checkpoint ? `<prior-checkpoint-evidence>\n${boundHandoffText(JSON.stringify({
      objective: checkpoint.objective, decisions: checkpoint.decisions,
      constraints: checkpoint.constraints, negativeKnowledge: checkpoint.negativeKnowledge,
      nextActions: checkpoint.nextActions, activeArtifacts: checkpoint.activeArtifacts,
      verification: checkpoint.verification, progress: checkpoint.progress,
      openQuestions: checkpoint.openQuestions, risks: checkpoint.risks,
    }, null, 2), 10_000)}\n</prior-checkpoint-evidence>` : "",
    `<prior-run-report>\n${boundHandoffText(previous.final_report ?? "No final report was recorded; inspect prior-run artifacts before proceeding.", 8_000)}\n</prior-run-report>`,
    "</previous-run-context>",
    config.planningContext && !prompt.includes("<connected-context>")
      ? renderConnectedHandoff(config.planningContext) : "",
    prompt,
  ];
  return sections.filter(Boolean).join("\n\n");
}
