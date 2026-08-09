import type Database from "better-sqlite3";
import { getContribution, getLineage, getQueueEntry,
  type ContributionRow, type QueueRow } from "./worktree-integration-repo.ts";
import { projectWorkItemIntegrationState } from "./worktree-integration-projection.ts";

export interface LineageResolutionRunRow { lineage_id: string; run_key: string; work_item_id: string;
  state: "active" | "resolved" | "failed"; revision: number; head_sha: string | null;
  error: string | null; started_at: number; finished_at: number | null }

function audit(db: Database.Database, input: { lineageId: string; contributionId?: string;
  queueId?: string; event: string; actor?: string; details?: unknown; at: number }) {
  db.prepare(`INSERT INTO worktree_integration_audit
    (lineage_id,contribution_id,queue_id,event,actor,details,recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(input.lineageId, input.contributionId ?? null, input.queueId ?? null, input.event,
      input.actor ?? null, JSON.stringify(input.details ?? null), input.at);
}

export function transitionContributionProvisioning(db: Database.Database, input: {
  contributionId: string; expectedRevision: number; outcome: "provisioning" | "active" | "failed";
  actor?: string; error?: string; at: number }): ContributionRow {
  return db.transaction(() => {
    const row = getContribution(db, input.contributionId);
    if (!row || row.revision !== input.expectedRevision) throw new Error("stale contribution revision");
    const allowed = input.outcome === "provisioning" ? row.state === "planned"
      : ["provisioning", "planned"].includes(row.state);
    if (!allowed) throw new Error("illegal contribution provisioning transition");
    db.prepare("UPDATE worktree_contributions SET state=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(input.outcome, input.at, row.id);
    projectWorkItemIntegrationState(db, { workItemId: row.work_item_id, state: input.outcome, at: input.at });
    audit(db, { lineageId: row.lineage_id, contributionId: row.id,
      event: `contribution_${input.outcome}`, actor: input.actor, details: { error: input.error }, at: input.at });
    return getContribution(db, row.id)!;
  }).immediate();
}

export function adoptLegacyContribution(db: Database.Database, input: { id: string; lineageId: string;
  workItemId: string; runKey: string; branchName: string; worktreePath: string;
  baseSha: string; headSha: string; actor: string; at: number }): ContributionRow {
  return db.transaction(() => {
    const lineage = getLineage(db, input.lineageId);
    if (!lineage || lineage.status !== "open") throw new Error("open lineage required");
    if (!db.prepare(`SELECT 1 FROM worktree_lineage_memberships
      WHERE lineage_id=? AND work_item_id=? AND status='active'`).get(lineage.id, input.workItemId))
      throw new Error("active lineage membership required");
    db.prepare(`INSERT INTO worktree_contributions (id,lineage_id,work_item_id,originating_run_key,
      branch_name,worktree_path,base_sha,head_sha,state,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(input.id, lineage.id,
        input.workItemId, input.runKey, input.branchName, input.worktreePath,
        input.baseSha, input.headSha, input.at, input.at);
    db.prepare(`INSERT INTO worktree_contribution_runs
      (contribution_id,run_key,kind,attached_at) VALUES (?, ?, 'original', ?)`)
      .run(input.id, input.runKey, input.at);
    audit(db, { lineageId: lineage.id, contributionId: input.id, event: "legacy_contribution_adopted",
      actor: input.actor, details: { baseSha: input.baseSha, headSha: input.headSha,
        branchName: input.branchName, worktreePath: input.worktreePath }, at: input.at });
    projectWorkItemIntegrationState(db, { workItemId: input.workItemId, state: "active", at: input.at });
    return getContribution(db, input.id)!;
  }).immediate();
}

export function requeueRunning(db: Database.Database, input: { queueId: string; workerId: string;
  fencingToken: number; reason: string; at: number }): QueueRow {
  return db.transaction(() => {
    const row = getQueueEntry(db, input.queueId);
    if (!row || row.state !== "running" || row.worker_id !== input.workerId
      || row.fencing_token !== input.fencingToken) throw new Error("running queue worker fence required");
    db.prepare(`UPDATE worktree_integration_queue SET state='queued',revision=revision+1,
      worker_id=NULL,started_at=NULL,error=?,updated_at=?
      WHERE id=? AND state='running' AND worker_id=? AND fencing_token=?`)
      .run(input.reason, input.at, row.id, input.workerId, input.fencingToken);
    if (row.contribution_id) db.prepare(`UPDATE worktree_contributions SET state='queued',
      revision=revision+1,updated_at=? WHERE id=?`).run(input.at, row.contribution_id);
    if (row.contribution_id) {
      const contribution = getContribution(db, row.contribution_id)!;
      projectWorkItemIntegrationState(db, { workItemId: contribution.work_item_id, state: "queued", at: input.at });
    } else {
      db.prepare(`UPDATE worktree_lineages SET integration_state='queued',revision=revision+1,updated_at=?
        WHERE id=?`).run(input.at, row.lineage_id);
      const members = db.prepare(`SELECT work_item_id FROM worktree_lineage_memberships
        WHERE lineage_id=? AND status='active'`).all(row.lineage_id) as Array<{ work_item_id: string }>;
      for (const member of members) projectWorkItemIntegrationState(db,
        { workItemId: member.work_item_id, state: "queued", at: input.at });
    }
    audit(db, { lineageId: row.lineage_id, contributionId: row.contribution_id ?? undefined,
      queueId: row.id, event: "integration_requeued", actor: input.workerId,
      details: { reason: input.reason, fencingToken: input.fencingToken }, at: input.at });
    return getQueueEntry(db, row.id)!;
  }).immediate();
}

export function resolveLineagePromotionConflict(db: Database.Database, input: { lineageId: string;
  expectedRevision: number; integrationHeadSha: string; actor: string; reason: string; at: number }) {
  return db.transaction(() => {
    const row = getLineage(db, input.lineageId);
    if (!row || row.integration_state !== "conflicted" || row.revision !== input.expectedRevision)
      throw new Error("conflicted lineage revision required");
    db.prepare(`UPDATE worktree_lineages SET integration_state='active',integration_head_sha=?,
      revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
      .run(input.integrationHeadSha, input.at, row.id, input.expectedRevision);
    db.prepare(`UPDATE worktree_integration_gates SET status='pending',recorded_at=?
      WHERE lineage_id=? AND scope='lineage'`).run(input.at, row.id);
    const members = db.prepare(`SELECT work_item_id FROM worktree_lineage_memberships
      WHERE lineage_id=? AND status='active'`).all(row.id) as Array<{ work_item_id: string }>;
    for (const member of members) projectWorkItemIntegrationState(db,
      { workItemId: member.work_item_id, state: "active", at: input.at });
    audit(db, { lineageId: row.id, event: "lineage_conflict_resolved", actor: input.actor,
      details: { integrationHeadSha: input.integrationHeadSha, reason: input.reason }, at: input.at });
    return getLineage(db, row.id)!;
  }).immediate();
}

export function getLineageResolutionRun(db: Database.Database, runKey: string) {
  return db.prepare("SELECT * FROM worktree_lineage_resolution_runs WHERE run_key=?")
    .get(runKey) as LineageResolutionRunRow | undefined;
}

export function attachLineageResolutionRun(db: Database.Database, input: { lineageId: string;
  workItemId: string; runKey: string; expectedLineageRevision: number; actor: string; at: number }): LineageResolutionRunRow {
  return db.transaction(() => {
    const lineage = getLineage(db, input.lineageId);
    if (!lineage || lineage.integration_state !== "conflicted"
      || lineage.revision !== input.expectedLineageRevision) throw new Error("conflicted lineage revision required");
    if (!db.prepare(`SELECT 1 FROM worktree_lineage_memberships
      WHERE lineage_id=? AND work_item_id=? AND status='active'`).get(lineage.id, input.workItemId))
      throw new Error("active lineage membership required");
    db.prepare(`INSERT INTO worktree_lineage_resolution_runs
      (lineage_id,run_key,work_item_id,state,started_at) VALUES (?, ?, ?, 'active', ?)`)
      .run(lineage.id, input.runKey, input.workItemId, input.at);
    db.prepare("UPDATE worktree_lineages SET revision=revision+1,updated_at=? WHERE id=? AND revision=?")
      .run(input.at, lineage.id, input.expectedLineageRevision);
    audit(db, { lineageId: lineage.id, event: "lineage_resolution_run_attached", actor: input.actor,
      details: { runKey: input.runKey, workItemId: input.workItemId }, at: input.at });
    return getLineageResolutionRun(db, input.runKey)!;
  }).immediate();
}

export function completeLineageResolutionRun(db: Database.Database, input: { runKey: string;
  expectedRunRevision: number; expectedLineageRevision: number; integrationHeadSha: string;
  actor: string; at: number }): LineageResolutionRunRow {
  return db.transaction(() => {
    const run = getLineageResolutionRun(db, input.runKey);
    if (!run || run.state !== "active" || run.revision !== input.expectedRunRevision)
      throw new Error("active lineage resolution run revision required");
    resolveLineagePromotionConflict(db, { lineageId: run.lineage_id,
      expectedRevision: input.expectedLineageRevision, integrationHeadSha: input.integrationHeadSha,
      actor: input.actor, reason: `resolution run ${run.run_key} completed`, at: input.at });
    db.prepare(`UPDATE worktree_lineage_resolution_runs SET state='resolved',head_sha=?,
      revision=revision+1,finished_at=? WHERE run_key=? AND state='active' AND revision=?`)
      .run(input.integrationHeadSha, input.at, run.run_key, input.expectedRunRevision);
    audit(db, { lineageId: run.lineage_id, event: "lineage_resolution_run_completed", actor: input.actor,
      details: { runKey: run.run_key, integrationHeadSha: input.integrationHeadSha }, at: input.at });
    return getLineageResolutionRun(db, run.run_key)!;
  }).immediate();
}

export function failLineageResolutionRun(db: Database.Database, input: { runKey: string;
  expectedRunRevision: number; error: string; actor: string; at: number }): LineageResolutionRunRow {
  return db.transaction(() => {
    const run = getLineageResolutionRun(db, input.runKey);
    if (!run || run.state !== "active" || run.revision !== input.expectedRunRevision)
      throw new Error("active lineage resolution run revision required");
    db.prepare(`UPDATE worktree_lineage_resolution_runs SET state='failed',error=?,
      revision=revision+1,finished_at=? WHERE run_key=? AND state='active' AND revision=?`)
      .run(input.error, input.at, run.run_key, input.expectedRunRevision);
    audit(db, { lineageId: run.lineage_id, event: "lineage_resolution_run_failed", actor: input.actor,
      details: { runKey: run.run_key, error: input.error }, at: input.at });
    return getLineageResolutionRun(db, run.run_key)!;
  }).immediate();
}

function waiveScopedGate(db: Database.Database, input: { lineageId: string; contributionId?: string;
  name: string; actor: string; reason: string; at: number }) {
  return db.transaction(() => {
    const scope = input.contributionId ? "contribution" : "lineage";
    const row = db.prepare(`SELECT id FROM worktree_integration_gates WHERE lineage_id=? AND scope=?
      AND ${input.contributionId ? "contribution_id=? AND" : "contribution_id IS NULL AND"} name=?`)
      .get(...(input.contributionId
        ? [input.lineageId, scope, input.contributionId, input.name]
        : [input.lineageId, scope, input.name])) as { id: string } | undefined;
    if (!row) throw new Error("gate not found");
    db.prepare("UPDATE worktree_integration_gates SET status='waived',details=?,recorded_at=? WHERE id=?")
      .run(JSON.stringify({ actor: input.actor, reason: input.reason }), input.at, row.id);
    if (input.contributionId) db.prepare(`UPDATE worktree_contributions
      SET revision=revision+1,updated_at=? WHERE id=?`).run(input.at, input.contributionId);
    else db.prepare("UPDATE worktree_lineages SET revision=revision+1,updated_at=? WHERE id=?")
      .run(input.at, input.lineageId);
    audit(db, { lineageId: input.lineageId, contributionId: input.contributionId,
      event: `${scope}_gate_waived`, actor: input.actor,
      details: { name: input.name, reason: input.reason }, at: input.at });
  }).immediate();
}
export const waiveContributionGate = (db: Database.Database, input: { lineageId: string;
  contributionId: string; name: string; actor: string; reason: string; at: number }) => waiveScopedGate(db, input);
export const waiveLineageGate = (db: Database.Database, input: { lineageId: string;
  name: string; actor: string; reason: string; at: number }) => waiveScopedGate(db, input);

export function discardContribution(db: Database.Database, input: { contributionId: string;
  expectedRevision: number; actor: string; reason: string; at: number }): ContributionRow {
  return db.transaction(() => {
    const row = getContribution(db, input.contributionId);
    if (!row || row.revision !== input.expectedRevision) throw new Error("stale contribution revision");
    if (["integrated","discarded"].includes(row.state)) throw new Error("terminal contribution is immutable");
    if (db.prepare("SELECT 1 FROM worktree_integration_queue WHERE contribution_id=? AND state='running'").get(row.id))
      throw new Error("running contribution cannot be discarded");
    db.prepare(`UPDATE worktree_integration_queue SET state='cancelled',revision=revision+1,
      finished_at=?,updated_at=? WHERE contribution_id=? AND state='queued'`).run(input.at, input.at, row.id);
    db.prepare(`UPDATE worktree_contributions SET state='discarded',revision=revision+1,updated_at=? WHERE id=?`)
      .run(input.at, row.id);
    projectWorkItemIntegrationState(db, { workItemId: row.work_item_id, state: "discarded", at: input.at });
    audit(db, { lineageId: row.lineage_id, contributionId: row.id,
      event: "contribution_discarded", actor: input.actor, details: { reason: input.reason }, at: input.at });
    return getContribution(db, row.id)!;
  }).immediate();
}
export function cancelQueuedIntegration(db: Database.Database, input: { queueId: string;
  expectedRevision: number; actor: string; reason: string; at: number }): QueueRow {
  return db.transaction(() => {
    const row = getQueueEntry(db, input.queueId);
    if (!row || row.state !== "queued" || row.revision !== input.expectedRevision)
      throw new Error("queued integration revision required");
    db.prepare(`UPDATE worktree_integration_queue SET state='cancelled',revision=revision+1,
      error=?,finished_at=?,updated_at=? WHERE id=?`).run(input.reason, input.at, input.at, row.id);
    if (row.contribution_id) db.prepare(`UPDATE worktree_contributions SET state='ready',
      revision=revision+1,updated_at=? WHERE id=?`).run(input.at, row.contribution_id);
    if (row.contribution_id) {
      const contribution = getContribution(db, row.contribution_id)!;
      projectWorkItemIntegrationState(db, { workItemId: contribution.work_item_id, state: "ready", at: input.at });
    } else {
      db.prepare(`UPDATE worktree_lineages SET integration_state='active',revision=revision+1,updated_at=?
        WHERE id=?`).run(input.at, row.lineage_id);
      const members = db.prepare(`SELECT work_item_id FROM worktree_lineage_memberships
        WHERE lineage_id=? AND status='active'`).all(row.lineage_id) as Array<{ work_item_id: string }>;
      for (const member of members) projectWorkItemIntegrationState(db,
        { workItemId: member.work_item_id, state: "active", at: input.at });
    }
    audit(db, { lineageId: row.lineage_id, contributionId: row.contribution_id ?? undefined,
      queueId: row.id, event: "integration_cancelled", actor: input.actor,
      details: { reason: input.reason }, at: input.at });
    return getQueueEntry(db, row.id)!;
  }).immediate();
}
export function recordConflictStrategy(db: Database.Database, input: { contributionId: string;
  strategy: string; actor: string; reason: string; at: number }): void {
  const row = getContribution(db, input.contributionId); if (!row) throw new Error("contribution not found");
  audit(db, { lineageId: row.lineage_id, contributionId: row.id, event: "conflict_strategy_recorded",
    actor: input.actor, details: { strategy: input.strategy, reason: input.reason }, at: input.at });
}
