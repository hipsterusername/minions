import type Database from "better-sqlite3";
import { projectWorkItemIntegrationState,
  type DurableIntegrationProjection } from "./worktree-integration-projection.ts";

export type ContributionState = "planned" | "provisioning" | "active" | "ready" | "queued" | "integrating" | "integrated" | "conflicted" | "failed" | "discarded";
export type QueueState = "queued" | "running" | "succeeded" | "conflicted" | "failed" | "cancelled";
export interface LineageRow { id: string; project_id: string; repository_path: string; target_ref: string;
  base_sha: string; integration_ref: string; integration_worktree_path: string;
  integration_head_sha: string | null; revision: number;
  integration_state: "active" | "queued" | "integrating" | "conflicted" | "integrated" | "abandoned";
  status: "open" | "integrated" | "abandoned"; created_at: number; updated_at: number }
export interface ContributionRow { id: string; lineage_id: string; work_item_id: string;
  originating_run_key: string; branch_name: string; worktree_path: string; base_sha: string;
  head_sha: string | null; revision: number; state: ContributionState; review_state: "pending" | "approved" | "rejected";
  cleanup_state: "retained" | "eligible" | "cleaned"; created_at: number; updated_at: number }
export interface QueueRow { id: string; lineage_id: string; contribution_id: string | null;
  kind: "contribution" | "lineage"; repository_path: string; target_ref: string;
  idempotency_key: string; revision: number; state: QueueState; attempt: number; worker_id: string | null;
  fencing_token: number;
  expected_source_sha: string; expected_target_sha: string;
  result_sha: string | null; error: string | null; enqueued_at: number; started_at: number | null;
  conflict_details_json: string | null;
  finished_at: number | null; updated_at: number }

const json = (value: unknown) => value === undefined ? null : JSON.stringify(value);
function audit(db: Database.Database, input: { lineageId: string; contributionId?: string | null;
  queueId?: string | null; event: string; actor?: string; details?: unknown; at: number }) {
  db.prepare(`INSERT INTO worktree_integration_audit
    (lineage_id, contribution_id, queue_id, event, actor, details, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.lineageId, input.contributionId ?? null,
      input.queueId ?? null, input.event, input.actor ?? null, json(input.details), input.at);
}
export const getLineage = (db: Database.Database, id: string) => db.prepare(
  "SELECT * FROM worktree_lineages WHERE id = ?").get(id) as LineageRow | undefined;
export const getContribution = (db: Database.Database, id: string) => db.prepare(
  "SELECT * FROM worktree_contributions WHERE id = ?").get(id) as ContributionRow | undefined;
export const getQueueEntry = (db: Database.Database, id: string) => db.prepare(
  "SELECT * FROM worktree_integration_queue WHERE id = ?").get(id) as QueueRow | undefined;
export function getQueuePosition(db: Database.Database, queueId: string): number | null {
  const row = getQueueEntry(db, queueId); if (!row || row.state !== "queued") return null;
  const result = db.prepare(`SELECT COUNT(*) AS count FROM worktree_integration_queue
    WHERE repository_path=? AND target_ref=? AND state='queued'
    AND (enqueued_at<? OR (enqueued_at=? AND id<?))`).get(row.repository_path,
      row.target_ref, row.enqueued_at, row.enqueued_at, row.id) as { count: number };
  return result.count + 1;
}

function projectContribution(db: Database.Database, row: Pick<ContributionRow, "work_item_id">,
  state: DurableIntegrationProjection, at: number): void {
  projectWorkItemIntegrationState(db, { workItemId: row.work_item_id, state, at });
}
function projectLineageMembers(db: Database.Database, lineageId: string,
  state: DurableIntegrationProjection, at: number): void {
  const rows = db.prepare(`SELECT work_item_id FROM worktree_lineage_memberships
    WHERE lineage_id=? AND status='active' ORDER BY work_item_id`).all(lineageId) as Array<{ work_item_id: string }>;
  for (const row of rows) projectWorkItemIntegrationState(db,
    { workItemId: row.work_item_id, state, at });
}

export function createLineage(db: Database.Database, input: { id: string; repositoryPath: string;
  projectId: string; targetRef: string; baseSha: string; integrationRef: string;
  integrationWorktreePath: string; at: number; actor?: string }): LineageRow {
  return db.transaction(() => {
    db.prepare(`INSERT INTO worktree_lineages (id,project_id,repository_path,target_ref,base_sha,
      integration_ref,integration_worktree_path,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.projectId, input.repositoryPath, input.targetRef, input.baseSha,
        input.integrationRef, input.integrationWorktreePath, input.at, input.at);
    audit(db, { lineageId: input.id, event: "lineage_created", actor: input.actor,
      details: { projectId: input.projectId, repositoryPath: input.repositoryPath,
        targetRef: input.targetRef, baseSha: input.baseSha, integrationRef: input.integrationRef }, at: input.at });
    return getLineage(db, input.id)!;
  }).immediate();
}

export function addContribution(db: Database.Database, input: { id: string; lineageId: string;
  workItemId: string; runKey: string; branchName: string; worktreePath: string;
  baseSha: string; state?: "planned" | "provisioning" | "active"; at: number; actor?: string }): ContributionRow {
  return db.transaction(() => {
    const lineage = getLineage(db, input.lineageId);
    if (!lineage || lineage.status !== "open") throw new Error("open lineage required");
    if (!db.prepare(`SELECT 1 FROM worktree_lineage_memberships
      WHERE lineage_id=? AND work_item_id=? AND status='active'`).get(lineage.id, input.workItemId))
      throw new Error("active lineage membership required");
    if ((lineage.integration_head_sha ?? lineage.base_sha) !== input.baseSha)
      throw new Error("contribution base must match current lineage head");
    db.prepare(`INSERT INTO worktree_contributions (id, lineage_id, work_item_id,
      originating_run_key, branch_name, worktree_path, base_sha, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.lineageId, input.workItemId,
        input.runKey, input.branchName, input.worktreePath, input.baseSha, input.state ?? "active", input.at, input.at);
    db.prepare(`INSERT INTO worktree_contribution_runs
      (contribution_id, run_key, kind, attached_at) VALUES (?, ?, 'original', ?)`)
      .run(input.id, input.runKey, input.at);
    audit(db, { lineageId: input.lineageId, contributionId: input.id,
      event: "contribution_added", actor: input.actor,
      details: { runKey: input.runKey, branchName: input.branchName, worktreePath: input.worktreePath }, at: input.at });
    projectContribution(db, getContribution(db, input.id)!, input.state ?? "active", input.at);
    return getContribution(db, input.id)!;
  }).immediate();
}

export function attachResolutionRun(db: Database.Database, input: { contributionId: string;
  runKey: string; expectedRevision: number; at: number; actor?: string }): ContributionRow {
  return db.transaction(() => {
    const row = getContribution(db, input.contributionId);
    if (!row || row.state !== "conflicted" || row.revision !== input.expectedRevision) throw new Error("conflicted contribution revision required");
    db.prepare(`INSERT INTO worktree_contribution_runs
      (contribution_id, run_key, kind, attached_at) VALUES (?, ?, 'resolution', ?)`)
      .run(row.id, input.runKey, input.at);
    db.prepare("UPDATE worktree_contributions SET state = 'active', revision=revision+1, updated_at = ? WHERE id = ?")
      .run(input.at, row.id);
    db.prepare(`UPDATE worktree_integration_gates SET status='pending',recorded_at=?
      WHERE contribution_id=? AND scope='contribution'`).run(input.at, row.id);
    projectContribution(db, row, "active", input.at);
    audit(db, { lineageId: row.lineage_id, contributionId: row.id,
      event: "resolution_run_attached", actor: input.actor, details: { runKey: input.runKey }, at: input.at });
    return getContribution(db, row.id)!;
  }).immediate();
}

export function attachContributionIteration(db: Database.Database, input: { contributionId: string;
  runKey: string; expectedRevision: number; at: number; actor?: string }): ContributionRow {
  return db.transaction(() => {
    const row = getContribution(db, input.contributionId);
    if (!row || row.revision !== input.expectedRevision || !["active","ready","failed"].includes(row.state))
      throw new Error("reusable contribution revision required");
    db.prepare(`INSERT INTO worktree_contribution_runs
      (contribution_id,run_key,kind,attached_at) VALUES (?, ?, 'iteration', ?)`)
      .run(row.id, input.runKey, input.at);
    db.prepare(`UPDATE worktree_contributions SET state='active',review_state='pending',
      revision=revision+1,updated_at=? WHERE id=?`).run(input.at, row.id);
    db.prepare(`UPDATE worktree_integration_gates SET status='pending',recorded_at=?
      WHERE contribution_id=? AND scope='contribution'`).run(input.at, row.id);
    projectContribution(db, row, "active", input.at);
    audit(db, { lineageId: row.lineage_id, contributionId: row.id,
      event: "iteration_run_attached", actor: input.actor, details: { runKey: input.runKey }, at: input.at });
    return getContribution(db, row.id)!;
  }).immediate();
}

export function setContributionHead(db: Database.Database, input: { contributionId: string;
  headSha: string; expectedRevision: number; at: number; actor?: string }): ContributionRow {
  return db.transaction(() => {
    const row = getContribution(db, input.contributionId); if (!row) throw new Error("contribution not found");
    if (row.revision !== input.expectedRevision) throw new Error("stale contribution revision");
    if (["queued", "integrating"].includes(row.state)) throw new Error("queued contribution head is frozen");
    if (["integrated", "discarded"].includes(row.state)) throw new Error("terminal contribution is immutable");
    db.prepare(`UPDATE worktree_contributions SET head_sha = ?, state = 'ready',
      review_state = 'pending', revision=revision+1, updated_at = ? WHERE id = ?`).run(input.headSha, input.at, row.id);
    db.prepare(`UPDATE worktree_integration_gates SET status='pending',recorded_at=?
      WHERE contribution_id=? AND scope='contribution'`).run(input.at, row.id);
    projectContribution(db, row, "ready", input.at);
    audit(db, { lineageId: row.lineage_id, contributionId: row.id,
      event: "contribution_head_recorded", actor: input.actor, details: { headSha: input.headSha }, at: input.at });
    return getContribution(db, row.id)!;
  }).immediate();
}

function enqueue(db: Database.Database, input: { id: string; lineageId: string;
  contributionId?: string; kind: "contribution" | "lineage"; idempotencyKey: string;
  expectedTargetSha?: string; at: number }): QueueRow {
  return db.transaction(() => {
    const replay = db.prepare("SELECT * FROM worktree_integration_queue WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as QueueRow | undefined; if (replay) return replay;
    const lineage = getLineage(db, input.lineageId); if (!lineage || lineage.status !== "open") throw new Error("open lineage required");
    if (input.kind === "lineage" && lineage.integration_state !== "active")
      throw new Error("active lineage required for promotion");
    if (input.kind === "contribution") {
      const row = input.contributionId ? getContribution(db, input.contributionId) : undefined;
      if (!row || row.lineage_id !== lineage.id || row.state !== "ready" || row.review_state !== "approved" || !row.head_sha)
        throw new Error("approved ready contribution with head required");
      const approval = db.prepare(`SELECT decision,reviewed_head_sha FROM worktree_integration_reviews
        WHERE contribution_id=? AND scope='contribution' ORDER BY recorded_at DESC,rowid DESC LIMIT 1`)
        .get(row.id) as { decision: string; reviewed_head_sha: string | null } | undefined;
      if (approval?.decision !== "approved" || approval.reviewed_head_sha !== row.head_sha)
        throw new Error("current contribution head requires approval");
      const badGate = db.prepare(`SELECT 1 FROM worktree_integration_gates
        WHERE contribution_id = ? AND status NOT IN ('passed','waived') LIMIT 1`).get(row.id);
      if (badGate) throw new Error("contribution gates are not satisfied");
    } else {
      if (!db.prepare(`SELECT 1 FROM worktree_contributions WHERE lineage_id=?
        AND state='integrated' LIMIT 1`).get(lineage.id)) throw new Error("at least one integrated contribution required");
      const approval = db.prepare(`SELECT decision,reviewed_head_sha FROM worktree_integration_reviews
        WHERE lineage_id = ? AND scope = 'lineage' ORDER BY recorded_at DESC, rowid DESC LIMIT 1`)
        .get(lineage.id) as { decision: string; reviewed_head_sha: string | null } | undefined;
      if (approval?.decision !== "approved"
        || approval.reviewed_head_sha !== (lineage.integration_head_sha ?? lineage.base_sha))
        throw new Error("current lineage head requires final approval");
      if (db.prepare(`SELECT 1 FROM worktree_contributions WHERE lineage_id=?
        AND state NOT IN ('integrated','discarded') LIMIT 1`).get(lineage.id))
        throw new Error("all contributions must be integrated or discarded");
      if (db.prepare(`SELECT 1 FROM worktree_integration_queue WHERE lineage_id=?
        AND kind='contribution' AND state IN ('queued','running') LIMIT 1`).get(lineage.id))
        throw new Error("contribution integration is still pending");
      if (db.prepare(`SELECT 1 FROM worktree_integration_gates WHERE lineage_id=? AND scope='lineage' AND name<>'promotion_runtime'
        AND status NOT IN ('passed','waived') LIMIT 1`).get(lineage.id))
        throw new Error("lineage gates are not satisfied");
    }
    const contribution = input.contributionId ? getContribution(db, input.contributionId) : undefined;
    const expectedSourceSha = contribution?.head_sha ?? lineage.integration_head_sha ?? lineage.base_sha;
    const expectedTargetSha = input.kind === "contribution"
      ? lineage.integration_head_sha ?? lineage.base_sha : input.expectedTargetSha;
    if (!expectedTargetSha) throw new Error("promotion target head snapshot required");
    db.prepare(`INSERT INTO worktree_integration_queue (id,lineage_id,contribution_id,kind,
      repository_path,target_ref,idempotency_key,expected_source_sha,expected_target_sha,enqueued_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, lineage.id, input.contributionId ?? null, input.kind,
        lineage.repository_path, input.kind === "contribution" ? lineage.integration_ref : lineage.target_ref,
        input.idempotencyKey, expectedSourceSha, expectedTargetSha, input.at, input.at);
    if (input.contributionId) db.prepare(`UPDATE worktree_contributions
      SET state='queued',revision=revision+1,updated_at=? WHERE id=?`)
      .run(input.at, input.contributionId);
    else db.prepare("UPDATE worktree_lineages SET revision=revision+1,updated_at=? WHERE id=?")
      .run(input.at, lineage.id);
    if (input.kind === "lineage") db.prepare(`UPDATE worktree_lineages
      SET integration_state='queued' WHERE id=?`).run(lineage.id);
    if (contribution) projectContribution(db, contribution, "queued", input.at);
    else projectLineageMembers(db, lineage.id, "queued", input.at);
    audit(db, { lineageId: lineage.id, contributionId: input.contributionId,
      queueId: input.id, event: "integration_enqueued", details: { kind: input.kind }, at: input.at });
    return getQueueEntry(db, input.id)!;
  }).immediate();
}
export const enqueueContribution = (db: Database.Database, input: { id: string; lineageId: string;
  contributionId: string; idempotencyKey: string; at: number }) => enqueue(db, { ...input, kind: "contribution" });
export const enqueueLineage = (db: Database.Database, input: { id: string; lineageId: string;
  idempotencyKey: string; expectedTargetSha: string; at: number }) => enqueue(db, { ...input, kind: "lineage" });

export function claimNext(db: Database.Database, input: { repositoryPath: string; targetRef: string;
  workerId: string; at: number }): QueueRow | null {
  return db.transaction(() => {
    if (db.prepare(`SELECT 1 FROM worktree_integration_queue WHERE repository_path=? AND target_ref=?
      AND state='running'`).get(input.repositoryPath, input.targetRef)) return null;
    const next = db.prepare(`SELECT * FROM worktree_integration_queue WHERE repository_path=?
      AND target_ref=? AND state='queued' ORDER BY enqueued_at, id LIMIT 1`)
      .get(input.repositoryPath, input.targetRef) as QueueRow | undefined; if (!next) return null;
    const changed = db.prepare(`UPDATE worktree_integration_queue SET state='running',revision=revision+1,
      fencing_token=fencing_token+1,worker_id=?,
      started_at=?,updated_at=? WHERE id=? AND state='queued'`).run(input.workerId, input.at, input.at, next.id);
    if (changed.changes !== 1) return null;
    if (next.contribution_id) db.prepare(`UPDATE worktree_contributions
      SET state='integrating',revision=revision+1,updated_at=? WHERE id=?`)
      .run(input.at, next.contribution_id);
    else db.prepare(`UPDATE worktree_lineages SET integration_state='integrating',
      revision=revision+1,updated_at=? WHERE id=?`).run(input.at, next.lineage_id);
    if (next.contribution_id) projectContribution(db, getContribution(db, next.contribution_id)!, "integrating", input.at);
    else projectLineageMembers(db, next.lineage_id, "integrating", input.at);
    audit(db, { lineageId: next.lineage_id, contributionId: next.contribution_id,
      queueId: next.id, event: "integration_claimed", actor: input.workerId, at: input.at });
    return getQueueEntry(db, next.id)!;
  }).immediate();
}

export function finishIntegration(db: Database.Database, input: { queueId: string;
  workerId: string; fencingToken: number; outcome: "succeeded" | "conflicted" | "failed";
  resultSha?: string; error?: string; conflictDetails?: { conflicts: string[]; preservedPaths: string[];
    targetSha: string; sourceSha: string }; at: number }): QueueRow {
  return db.transaction(() => {
    const row = getQueueEntry(db, input.queueId);
    if (!row || row.state !== "running" || row.worker_id !== input.workerId
      || row.fencing_token !== input.fencingToken) throw new Error("running queue worker fence required");
    if (input.outcome === "succeeded" && !input.resultSha) throw new Error("successful integration requires result sha");
    db.prepare(`UPDATE worktree_integration_queue SET state=?,revision=revision+1,result_sha=?,error=?,
      conflict_details_json=?,finished_at=?,updated_at=?
      WHERE id=? AND state='running' AND worker_id=? AND fencing_token=?`).run(input.outcome, input.resultSha ?? null,
        input.error ?? null, input.conflictDetails ? JSON.stringify(input.conflictDetails) : null,
        input.at, input.at, row.id, input.workerId, input.fencingToken);
    if (row.contribution_id) {
      const state = input.outcome === "succeeded" ? "integrated" : input.outcome === "conflicted" ? "conflicted" : "failed";
      db.prepare(`UPDATE worktree_contributions SET state=?, cleanup_state=?,
        revision=revision+1,updated_at=? WHERE id=?`)
        .run(state, input.outcome === "succeeded" ? "eligible" : "retained", input.at, row.contribution_id);
      projectContribution(db, getContribution(db, row.contribution_id)!,
        input.outcome === "succeeded" ? "contribution_integrated"
          : input.outcome === "conflicted" ? "conflicted" : "failed", input.at);
      if (input.outcome === "succeeded" && input.resultSha) {
        const lineage = getLineage(db, row.lineage_id)!;
        const changed = db.prepare(`UPDATE worktree_lineages SET integration_head_sha=?,revision=revision+1,
          updated_at=? WHERE id=? AND revision=?`).run(input.resultSha, input.at, lineage.id, lineage.revision);
        if (changed.changes !== 1) throw new Error("lineage head changed concurrently");
        db.prepare("UPDATE worktree_integration_gates SET status='pending',recorded_at=? WHERE lineage_id=? AND scope='lineage'")
          .run(input.at, lineage.id);
      }
    } else if (input.outcome === "succeeded") {
      db.prepare(`UPDATE worktree_lineages SET status='integrated',integration_state='integrated',integration_head_sha=COALESCE(?,integration_head_sha),
        revision=revision+1,updated_at=? WHERE id=?`).run(input.resultSha ?? null, input.at, row.lineage_id);
      projectLineageMembers(db, row.lineage_id, "lineage_integrated", input.at);
      db.prepare(`UPDATE worktree_lineage_memberships SET status='left',revision=revision+1,left_at=?
        WHERE lineage_id=? AND status='active'`).run(input.at, row.lineage_id);
    } else if (!row.contribution_id && input.outcome === "conflicted") {
      db.prepare(`UPDATE worktree_lineages SET integration_state='conflicted',
        revision=revision+1,updated_at=? WHERE id=?`).run(input.at, row.lineage_id);
      projectLineageMembers(db, row.lineage_id, "conflicted", input.at);
    } else if (!row.contribution_id) {
      db.prepare(`UPDATE worktree_lineages SET integration_state='active',
        revision=revision+1,updated_at=? WHERE id=?`).run(input.at, row.lineage_id);
      projectLineageMembers(db, row.lineage_id, "active", input.at);
    }
    audit(db, { lineageId: row.lineage_id, contributionId: row.contribution_id,
      queueId: row.id, event: `integration_${input.outcome}`, details: { resultSha: input.resultSha, error: input.error }, at: input.at });
    return getQueueEntry(db, row.id)!;
  }).immediate();
}

export function retryIntegration(db: Database.Database, input: { priorQueueId: string;
  id: string; idempotencyKey: string; expectedTargetSha?: string; at: number }): QueueRow {
  return db.transaction(() => {
    const replay = db.prepare("SELECT * FROM worktree_integration_queue WHERE idempotency_key=?")
      .get(input.idempotencyKey) as QueueRow | undefined; if (replay) return replay;
    const prior = getQueueEntry(db, input.priorQueueId);
    if (!prior || !["conflicted", "failed", "cancelled"].includes(prior.state)) throw new Error("retryable terminal entry required");
    if (prior.contribution_id) {
      const contribution = getContribution(db, prior.contribution_id)!;
      const allowed = prior.state === "failed" ? contribution.state === "failed"
        : contribution.state === "ready" && contribution.review_state === "approved";
      if (!allowed) throw new Error("conflict retry requires a resolved and re-approved contribution");
    } else {
      const lineage = getLineage(db, prior.lineage_id)!;
      const approval = db.prepare(`SELECT decision,reviewed_head_sha FROM worktree_integration_reviews
        WHERE lineage_id=? AND scope='lineage' ORDER BY recorded_at DESC,rowid DESC LIMIT 1`)
        .get(lineage.id) as { decision: string; reviewed_head_sha: string | null } | undefined;
      if (lineage.integration_state !== "active" || approval?.decision !== "approved"
        || approval.reviewed_head_sha !== (lineage.integration_head_sha ?? lineage.base_sha))
        throw new Error("promotion retry requires resolved gates and current final approval");
      if (db.prepare(`SELECT 1 FROM worktree_integration_gates WHERE lineage_id=? AND scope='lineage' AND name<>'promotion_runtime'
        AND status NOT IN ('passed','waived') LIMIT 1`).get(lineage.id))
        throw new Error("promotion retry gates are not satisfied");
    }
    const lineage = getLineage(db, prior.lineage_id)!;
    const contribution = prior.contribution_id ? getContribution(db, prior.contribution_id)! : undefined;
    const expectedSourceSha = contribution?.head_sha ?? lineage.integration_head_sha ?? lineage.base_sha;
    const expectedTargetSha = prior.kind === "contribution"
      ? lineage.integration_head_sha ?? lineage.base_sha : input.expectedTargetSha;
    if (!expectedTargetSha) throw new Error("promotion retry target head snapshot required");
    db.prepare(`INSERT INTO worktree_integration_queue (id,lineage_id,contribution_id,kind,
      repository_path,target_ref,idempotency_key,expected_source_sha,expected_target_sha,state,attempt,enqueued_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(input.id, prior.lineage_id,
        prior.contribution_id, prior.kind, prior.repository_path, prior.target_ref,
        input.idempotencyKey, expectedSourceSha, expectedTargetSha, prior.attempt + 1, input.at, input.at);
    if (prior.contribution_id) db.prepare(`UPDATE worktree_contributions
      SET state='queued',revision=revision+1,updated_at=? WHERE id=?`).run(input.at, prior.contribution_id);
    if (contribution) projectContribution(db, contribution, "queued", input.at);
    else {
      db.prepare(`UPDATE worktree_lineages SET integration_state='queued',revision=revision+1,updated_at=?
        WHERE id=?`).run(input.at, lineage.id);
      projectLineageMembers(db, lineage.id, "queued", input.at);
    }
    audit(db, { lineageId: prior.lineage_id, contributionId: prior.contribution_id,
      queueId: input.id, event: "integration_retried", details: { priorQueueId: prior.id }, at: input.at });
    return getQueueEntry(db, input.id)!;
  }).immediate();
}

export function markContributionCleaned(db: Database.Database, input: { contributionId: string;
  integrationQueueId: string; workerId: string; fencingToken: number;
  headReachable: boolean; at: number }): ContributionRow {
  return db.transaction(() => {
    const row = getContribution(db, input.contributionId);
    if (!row || row.state !== "integrated" || row.cleanup_state !== "eligible") throw new Error("eligible integrated contribution required");
    if (!input.headReachable) throw new Error("contribution head is not reachable from target");
    const queue = getQueueEntry(db, input.integrationQueueId);
    if (!queue || queue.contribution_id !== row.id || queue.state !== "succeeded"
      || queue.worker_id !== input.workerId || queue.fencing_token !== input.fencingToken)
      throw new Error("successful integration worker fence required for cleanup");
    db.prepare(`UPDATE worktree_contributions
      SET cleanup_state='cleaned',revision=revision+1,updated_at=? WHERE id=?`)
      .run(input.at, row.id);
    audit(db, { lineageId: row.lineage_id, contributionId: row.id,
      event: "contribution_cleaned", actor: input.workerId,
      details: { headReachable: true, queueId: queue.id, fencingToken: input.fencingToken }, at: input.at });
    return getContribution(db, row.id)!;
  }).immediate();
}

export function recoverInterruptedIntegrations(db: Database.Database, at: number): string[] {
  return db.transaction(() => {
    const rows = db.prepare("SELECT * FROM worktree_integration_queue WHERE state='running' ORDER BY started_at,id")
      .all() as QueueRow[];
    for (const row of rows) {
      db.prepare(`UPDATE worktree_integration_queue SET state='queued',revision=revision+1,worker_id=NULL,started_at=NULL,
        error='Recovered after interrupted worker',updated_at=? WHERE id=?`).run(at, row.id);
      if (row.contribution_id) db.prepare(`UPDATE worktree_contributions
        SET state='queued',revision=revision+1,updated_at=? WHERE id=?`)
        .run(at, row.contribution_id);
      if (row.contribution_id) projectContribution(db, getContribution(db, row.contribution_id)!, "queued", at);
      else {
        db.prepare(`UPDATE worktree_lineages SET integration_state='queued',revision=revision+1,updated_at=?
          WHERE id=?`).run(at, row.lineage_id);
        projectLineageMembers(db, row.lineage_id, "queued", at);
      }
      audit(db, { lineageId: row.lineage_id, contributionId: row.contribution_id,
        queueId: row.id, event: "integration_recovered", at });
    }
    return rows.map((row) => row.id);
  }).immediate();
}

export { getLineageState, findContributionByRun, findOpenLineageByWorkItem,
  findLatestLineageByWorkItem, listProjectLineages } from "./worktree-integration-query-repo.ts";
export { recordGate, recordLineageGate, recordContributionReview,
  recordLineageApproval } from "./worktree-integration-review-repo.ts";
