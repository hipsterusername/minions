import { projectWorkItemIntegrationState } from "./worktree-integration-projection.ts";
import type Database from "better-sqlite3";
import type { evaluateMergeGatesForContext, MergeGateVerdict } from "./system-model/gates.ts";
import * as repo from "./worktree-integration-repo.ts";

export function applyStoredWaivers(db: Database.Database, lineageId: string, contributionId: string | null, verdict: MergeGateVerdict): MergeGateVerdict {
  const rows = db.prepare(`SELECT name,details FROM worktree_integration_gates
    WHERE lineage_id=? AND contribution_id IS ? AND scope=? AND status='waived'`)
    .all(lineageId, contributionId, contributionId ? "contribution" : "lineage") as Array<{ name: string; details: string | null }>;
  const gates = verdict.gates.map(gate => {
    const row = rows.find(row => row.name === gate.id);
    const detail = row?.details ? JSON.parse(row.details) : null;
    return detail?.actor && !detail.advisoryStatus && detail.policyDigest === verdict.policyDigest
      ? { ...gate, status: "waived" as const, reason: detail.reason } : gate;
  });
  return { ...verdict, gates, allowed: verdict.allowed || !gates.some(gate =>
    gate.status === "required_pending" || gate.status === "failed") };
}
export async function evaluateRuntimePromotionGate(db: Database.Database,
  operation: { lineageId?: string | null },
  evaluate: (lineageId: string) => Promise<MergeGateVerdict>): Promise<{ allowed: boolean; reason?: string }> {
  if (!operation.lineageId) return { allowed: false, reason: "lineage identity required" };
  const state = repo.getLineageState(db, operation.lineageId);
  const failed = (state.gates as Array<{ scope: string; status: string; name: string }>)
    .find((gate) => gate.scope === "lineage" && gate.name !== "promotion_runtime"
      && !["passed", "waived"].includes(gate.status));
  if (failed) return { allowed: false, reason: `lineage gate ${failed.name} is ${failed.status}` };
  const current = await evaluate(operation.lineageId);
  return current.mode === "enforced" && !current.allowed
    ? { allowed: false, reason: "Current promotion evidence or policy gates failed; review the lineage again" }
    : { allowed: true };
}

export async function evaluatePromotionGates(db: Database.Database, lineageId: string, evaluate: typeof evaluateMergeGatesForContext): Promise<MergeGateVerdict> {
  const before = repo.getLineage(db, lineageId);
  if (!before) throw new Error("lineage not found");
  const resolution = db.prepare(`SELECT run_key FROM worktree_lineage_resolution_runs
    WHERE lineage_id=? AND state='resolved' AND head_sha=? ORDER BY finished_at DESC, rowid DESC LIMIT 1`)
    .get(before.id, before.integration_head_sha) as { run_key: string } | undefined;
  const combined = await evaluate({ worktree: { path: before.integration_worktree_path,
    branch: before.integration_ref.replace(/^refs\/heads\//, ""), leaderSessionKey: before.id,
    createdAt: before.created_at, projectPath: before.repository_path, lifecycle: "active" },
    cwd: before.integration_worktree_path, sessionKey: resolution?.run_key ?? before.id });
  return applyStoredWaivers(db, before.id, null, combined);
}

/** A closed contribution set can be verified in the retained combined worktree. */
export function markLineageVerificationNeeded(db: Database.Database, lineageId: string, at: number): string {
  const state = repo.getLineageState(db, lineageId);
  if (!state.contributions.some(row => row.state === "integrated")
    || state.contributions.some(row => !["integrated", "discarded"].includes(row.state))) return lineageId;
  db.prepare("UPDATE worktree_lineages SET integration_state='conflicted',revision=revision+1,updated_at=? WHERE id=? AND status='open'").run(at, lineageId);
  const members = db.prepare("SELECT work_item_id FROM worktree_lineage_memberships WHERE lineage_id=? AND status='active'")
    .all(lineageId) as Array<{ work_item_id: string }>;
  for (const member of members) projectWorkItemIntegrationState(db, { workItemId: member.work_item_id, state: "conflicted", at });
  return lineageId;
}
