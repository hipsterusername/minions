import type Database from "better-sqlite3";
import {
  semanticTaskGraphPlanSchema,
  taskGraphPlanSnapshotViewSchema,
  type LeaderOrchestrationMode,
  type SemanticTaskGraphPlan,
  type TaskGraphPlanReviewRequirement,
  type TaskGraphPlanSnapshotView,
  type TaskGraphPlanState,
} from "../../shared/task-graph-planning-contracts.ts";
import type { SourceSnapshot } from "../../shared/task-graph-contracts.ts";
import { TaskGraphConflictError, TaskGraphValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { canonicalId } from "./planning-compiler.ts";
import { migrateTaskGraph } from "./schema.ts";

type Row = Record<string, unknown>;

export interface PersistPlanningProposalInput {
  workItemId: string;
  primaryRunKey: string;
  mode: Exclude<LeaderOrchestrationMode, "direct">;
  requestId: string;
  baseProposalRevision: number | null;
  plan: SemanticTaskGraphPlan;
  state: "needs_input" | "ready" | "failed";
  graphRevisionId: string | null;
  nodeIdsByStepKey: Record<string, string>;
  sourceSnapshot: SourceSnapshot | null;
  sourceFingerprint: string | null;
  autoStartEligible: boolean;
  startBlockedReason: string | null;
  reviewRequirements: TaskGraphPlanReviewRequirement[];
  error: string | null;
}

export class TaskGraphPlanningRepository {
  constructor(readonly db: Database.Database) { migrateTaskGraph(db); }

  persist(input: PersistPlanningProposalInput, at: number): {
    snapshot: TaskGraphPlanSnapshotView; idempotent: boolean;
  } {
    const plan = semanticTaskGraphPlanSchema.parse(input.plan);
    const requestHash = contentHash({
      workItemId: input.workItemId,
      primaryRunKey: input.primaryRunKey,
      mode: input.mode,
      baseProposalRevision: input.baseProposalRevision,
      plan,
    });
    return this.db.transaction(() => {
      this.assertAuthority(input.workItemId, input.primaryRunKey);
      const replay = this.db.prepare(`SELECT * FROM task_graph_plan_proposals
        WHERE work_item_id=? AND primary_run_key=? AND request_id=?`)
        .get(input.workItemId, input.primaryRunKey, input.requestId) as Row | undefined;
      if (replay) {
        if (replay.request_hash !== requestHash) {
          throw new TaskGraphConflictError("planning request id was reused with different input");
        }
        return { snapshot: this.map(replay), idempotent: true };
      }
      const latest = this.latestRow(input.workItemId, input.primaryRunKey);
      const latestRevision = latest ? Number(latest.proposal_revision) : null;
      if (input.baseProposalRevision !== latestRevision) {
        throw new TaskGraphConflictError(
          "stale graph-plan proposal revision",
          latest ? this.map(latest) : null,
        );
      }
      if (latest?.graph_run_id) {
        throw new TaskGraphConflictError(
          "a started graph plan can only be revised in a new WorkItem iteration",
          this.map(latest),
        );
      }
      const proposalRevision = (latestRevision ?? 0) + 1;
      const projectionRevision = latest ? Number(latest.projection_revision) + 1 : 1;
      if (latest) this.db.prepare(`UPDATE task_graph_plan_proposals
        SET state='superseded',projection_revision=?,updated_at=? WHERE id=?`)
        .run(projectionRevision, at, latest.id);
      const proposalId = canonicalId("proposal", {
        workItemId: input.workItemId, primaryRunKey: input.primaryRunKey, proposalRevision, plan,
      });
      this.db.prepare(`INSERT INTO task_graph_plan_proposals (
        id,work_item_id,primary_run_key,proposal_revision,projection_revision,
        base_proposal_revision,state,mode,request_id,request_hash,plan_json,node_ids_json,
        graph_revision_id,graph_run_id,source_snapshot_json,source_fingerprint,
        auto_start_eligible,error,start_blocked_reason,review_requirements_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`).run(
        proposalId, input.workItemId, input.primaryRunKey, proposalRevision,
        projectionRevision, input.baseProposalRevision, input.state, input.mode,
        input.requestId, requestHash,
        JSON.stringify(plan), JSON.stringify(input.nodeIdsByStepKey), input.graphRevisionId,
        input.sourceSnapshot ? JSON.stringify(input.sourceSnapshot) : null,
        input.sourceFingerprint, Number(input.autoStartEligible),
        input.error ?? input.startBlockedReason,
        input.startBlockedReason, JSON.stringify(input.reviewRequirements), at, at,
      );
      return { snapshot: this.get(proposalId), idempotent: false };
    }).immediate();
  }

  get(proposalId: string): TaskGraphPlanSnapshotView {
    const row = this.db.prepare("SELECT * FROM task_graph_plan_proposals WHERE id=?")
      .get(proposalId) as Row | undefined;
    if (!row) throw new TaskGraphValidationError("graph-plan proposal not found");
    return this.map(row);
  }

  latest(workItemId: string, primaryRunKey?: string | null): TaskGraphPlanSnapshotView | null {
    const row = primaryRunKey
      ? this.latestRow(workItemId, primaryRunKey)
      : this.db.prepare(`SELECT * FROM task_graph_plan_proposals WHERE work_item_id=?
          ORDER BY updated_at DESC,proposal_revision DESC LIMIT 1`).get(workItemId) as Row | undefined;
    return row ? this.map(row) : null;
  }

  source(proposalId: string): { snapshot: SourceSnapshot; fingerprint: string } | null {
    const row = this.db.prepare(`SELECT source_snapshot_json,source_fingerprint
      FROM task_graph_plan_proposals WHERE id=?`).get(proposalId) as Row | undefined;
    if (!row?.source_snapshot_json || !row.source_fingerprint) return null;
    return { snapshot: JSON.parse(String(row.source_snapshot_json)) as SourceSnapshot,
      fingerprint: String(row.source_fingerprint) };
  }

  plan(proposalId: string): SemanticTaskGraphPlan {
    const row = this.db.prepare("SELECT plan_json FROM task_graph_plan_proposals WHERE id=?")
      .get(proposalId) as Row | undefined;
    if (!row) throw new TaskGraphValidationError("graph-plan proposal not found");
    return semanticTaskGraphPlanSchema.parse(JSON.parse(String(row.plan_json)));
  }

  transition(input: { proposalId: string; expectedProposalRevision: number;
    expectedProjectionRevision: number;
    state: TaskGraphPlanState; graphRunId?: string | null; error?: string | null }, at: number):
    TaskGraphPlanSnapshotView {
    const row = this.db.prepare("SELECT * FROM task_graph_plan_proposals WHERE id=?")
      .get(input.proposalId) as Row | undefined;
    if (!row) throw new TaskGraphValidationError("graph-plan proposal not found");
    if (Number(row.proposal_revision) !== input.expectedProposalRevision) {
      throw new TaskGraphConflictError("stale graph-plan proposal revision", this.map(row));
    }
    if (Number(row.projection_revision) !== input.expectedProjectionRevision) {
      throw new TaskGraphConflictError("stale graph-plan projection revision", this.map(row));
    }
    const result = this.db.prepare(`UPDATE task_graph_plan_proposals SET state=?,
      graph_run_id=COALESCE(?,graph_run_id),error=?,projection_revision=projection_revision+1,
      updated_at=? WHERE id=? AND proposal_revision=? AND projection_revision=?`).run(
      input.state, input.graphRunId ?? null, input.error ?? null, at,
      input.proposalId, input.expectedProposalRevision, input.expectedProjectionRevision,
    );
    if (result.changes !== 1) throw new TaskGraphConflictError("graph-plan transition lost authority");
    return this.get(input.proposalId);
  }

  proposalForRun(graphRunId: string): TaskGraphPlanSnapshotView | null {
    const row = this.db.prepare("SELECT * FROM task_graph_plan_proposals WHERE graph_run_id=?")
      .get(graphRunId) as Row | undefined;
    return row ? this.map(row) : null;
  }

  acknowledgeTerminalWake(proposalId: string, graphRunId: string, at: number): void {
    this.db.prepare(`UPDATE task_graph_plan_proposals SET terminal_wake_delivered_at=?
      WHERE id=? AND graph_run_id=? AND state IN ('completed','failed','cancelled')
      AND terminal_wake_delivered_at IS NULL`).run(at, proposalId, graphRunId);
  }

  private latestRow(workItemId: string, primaryRunKey: string): Row | undefined {
    return this.db.prepare(`SELECT * FROM task_graph_plan_proposals
      WHERE work_item_id=? AND primary_run_key=? ORDER BY proposal_revision DESC LIMIT 1`)
      .get(workItemId, primaryRunKey) as Row | undefined;
  }

  private assertAuthority(workItemId: string, primaryRunKey: string): void {
    const row = this.db.prepare("SELECT current_run_key FROM work_items WHERE id=?")
      .get(workItemId) as Row | undefined;
    if (!row || row.current_run_key !== primaryRunKey) {
      throw new TaskGraphConflictError("stale canonical WorkItem authority", row ?? null);
    }
  }

  private map(row: Row): TaskGraphPlanSnapshotView {
    const plan = semanticTaskGraphPlanSchema.parse(JSON.parse(String(row.plan_json)));
    const nodeIds = JSON.parse(String(row.node_ids_json)) as Record<string, string>;
    const state = String(row.state) as TaskGraphPlanState;
    return taskGraphPlanSnapshotViewSchema.parse({
      proposalId: row.id,
      workItemId: row.work_item_id,
      primaryRunKey: row.primary_run_key,
      revision: row.projection_revision,
      proposalRevision: row.proposal_revision,
      baseProposalRevision: row.base_proposal_revision,
      state,
      mode: row.mode,
      objective: plan.objective,
      acceptanceCriteria: plan.acceptanceCriteria,
      assumptions: plan.assumptions,
      questions: plan.questions,
      workPacketId: plan.workPacketId ?? null,
      steps: plan.steps.map((step) => ({
        key: step.key,
        nodeId: nodeIds[step.key] ?? null,
        title: step.title,
        objective: step.objective,
        acceptanceCriteria: step.acceptanceCriteria,
        dependsOn: step.dependsOn.map((dependency) => dependency.stepKey),
        contextSelectors: step.contextSelectors,
        executorClass: step.executorClass,
        risk: step.risk,
        requiresApproval: step.requiresApproval,
      })),
      materializedRevisionId: row.graph_revision_id,
      graphRunId: row.graph_run_id,
      sourceSnapshotId: row.source_snapshot_json
        ? (JSON.parse(String(row.source_snapshot_json)) as SourceSnapshot).id : null,
      autoStartEligible: Boolean(row.auto_start_eligible),
      canStart: state === "ready" && Boolean(row.graph_revision_id)
        && Boolean(row.source_snapshot_json) && !row.start_blocked_reason,
      reviewRequirements: JSON.parse(String(row.review_requirements_json ?? "[]")),
      error: row.error,
      updatedAt: row.updated_at,
    });
  }
}
