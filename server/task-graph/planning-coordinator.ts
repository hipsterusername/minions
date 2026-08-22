import type Database from "better-sqlite3";
import type { Bus } from "../bus.ts";
import { serverLogger } from "../logging.ts";
import {
  semanticTaskGraphPlanSchema,
  type LeaderOrchestrationMode,
  type SemanticTaskGraphPlan,
  type TaskGraphPlanSnapshotView,
  type TaskGraphPlanState,
} from "../../shared/task-graph-planning-contracts.ts";
import { TaskGraphConflictError, TaskGraphValidationError } from "./errors.ts";
import { canonicalId, compileSemanticGraphPlan } from "./planning-compiler.ts";
import {
  capturePlanningSource,
  type CapturedPlanningSource,
  type PlanningSourceContext,
} from "./planning-source.ts";
import { TaskGraphPlanningRepository } from "./planning-repository.ts";
import { storeScopedContextSources } from "./context-sources.ts";
import {cancelPlanningGraphRun,inspectPlanningHistory,readPlanningHistoryArtifact,
  synchronizeLatestPlanningRuntime,type PlanningHistorySelector,type PlanningInspection}
  from "./planning-inspection.ts";
import type { TaskGraphService } from "./service.ts";

type Row = Record<string, unknown>;
const log = serverLogger.child("task-graph-planning");

export type PlanningSourceAuthority=Omit<PlanningSourceContext,
  "workItemId"|"primaryRunKey"|"revisionId"|"plan"|"nodeIdsByStepKey">;

export interface TaskGraphPlanningCoordinatorOptions {
  db: Database.Database;
  bus: Bus;
  taskGraphs: TaskGraphService;
  resolveSourceAuthority: (
    workItemId: string,
    primaryRunKey: string,
  ) => PlanningSourceAuthority | null | Promise<PlanningSourceAuthority | null>;
  captureSource?: (input: PlanningSourceContext, at: number) => Promise<CapturedPlanningSource>;
  onTerminal?: (snapshot: TaskGraphPlanSnapshotView) => void;
  onAttention?: (snapshot: TaskGraphPlanSnapshotView, reason: "blocked",
    runRevision: number) => void;
  now?: () => number;
}

export class TaskGraphPlanningCoordinator {
  readonly repo: TaskGraphPlanningRepository;
  private readonly now: () => number;
  private readonly captureSource: NonNullable<TaskGraphPlanningCoordinatorOptions["captureSource"]>;
  private readonly attentionTokens = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly options: TaskGraphPlanningCoordinatorOptions) {
    this.repo = new TaskGraphPlanningRepository(options.db);
    this.now = options.now ?? Date.now;
    this.captureSource = options.captureSource ?? capturePlanningSource;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.bus.subscribe((envelope) => {
      if ((envelope.type !== "task_graph_snapshot" && envelope.type !== "task_graph_changed")
        || typeof envelope["runId"] !== "string") return;
      const status = envelope.type === "task_graph_snapshot"
        ? (envelope["snapshot"] as Record<string, unknown> | undefined)?.["status"]
        : (envelope["changes"] as Record<string, unknown> | undefined)?.["status"];
      if (typeof status === "string") this.reflectGraphStatus(
        envelope["runId"], status, Number(envelope["revision"] ?? 0),
      );
    });
    const recover = () => void this.recoverPersisted().then((deferred) => {
      if (deferred && this.unsubscribe) {
        this.recoveryTimer = setTimeout(recover, 5_000);
        this.recoveryTimer.unref?.();
      }
    }, (error: unknown) => log.warn("planning_recovery_failed", { error }));
    recover();
  }

  dispose(): void {
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  async submit(input: {
    workItemId: string;
    primaryRunKey: string;
    mode: Exclude<LeaderOrchestrationMode, "direct">;
    requestId: string;
    baseProposalRevision: number | null;
    plan: SemanticTaskGraphPlan;
  }): Promise<TaskGraphPlanSnapshotView> {
    const at = this.now();
    const plan = semanticTaskGraphPlanSchema.parse(input.plan);
    const authority = await this.requireAuthority(input.workItemId, input.primaryRunKey);
    synchronizeLatestPlanningRuntime(this.repo,this.options.taskGraphs,input.workItemId,
      input.primaryRunKey,(runId,status,revision)=>this.reflectGraphStatus(runId,status,revision));
    const proposalRevision = (input.baseProposalRevision ?? 0) + 1;
    const needsInput = plan.questions.length > 0;
    let compiled: ReturnType<typeof compileSemanticGraphPlan>;
    let captured: CapturedPlanningSource | null;
    try {
      compiled = compileSemanticGraphPlan({
        workItemId: input.workItemId,
        workspaceId: authority.workspaceId,
        primaryRunKey: input.primaryRunKey,
        proposalRevision,
        plan,
        defaultHarness: authority.harnessName,
        defaultAllowedTools: [...authority.allowedTools],
        validateNodePolicy: this.options.taskGraphs.options.validateNodePolicy,
      });
      captured = needsInput ? null : await this.capture(compiled.revision.revisionId,
        compiled.nodeIdsByStepKey, plan, authority, input.workItemId, input.primaryRunKey, at);
    } catch (error) {
      const failed = this.repo.persist({ ...input, plan, state: "failed",
        graphRevisionId: null, nodeIdsByStepKey: {}, sourceSnapshot: null,
        sourceFingerprint: null, autoStartEligible: false, startBlockedReason: null,
        reviewRequirements: [],
        error: error instanceof Error ? error.message : "Plan validation failed" }, at);
      if (!failed.idempotent) this.publish(failed.snapshot, "plan_validation_failed");
      return failed.snapshot;
    }
    const persisted = this.options.db.transaction(() => {
      const result = this.repo.persist({
        ...input,
        plan,
        state: needsInput ? "needs_input" : "ready",
        graphRevisionId: needsInput ? null : compiled.revision.revisionId,
        nodeIdsByStepKey: compiled.nodeIdsByStepKey,
        sourceSnapshot: captured?.snapshot ?? null,
        sourceFingerprint: captured?.fingerprint ?? null,
        autoStartEligible: compiled.autoStartEligible,
        startBlockedReason: captured?.startBlockedReason ?? null,
        reviewRequirements: captured?.reviewRequirements ?? [],
        error: null,
      }, at);
      if (captured && (!result.idempotent
        || captured.snapshot.id === result.snapshot.sourceSnapshotId)) {
        this.options.taskGraphs.createRevision(compiled.revision, at,
          `plan-revision:${result.snapshot.proposalId}`);
        storeScopedContextSources(this.options.db, captured.scopedSources, at);
      }
      return result;
    }).immediate();
    if (!persisted.idempotent) this.publish(persisted.snapshot, "plan_submitted");
    if (input.mode === "auto" && persisted.snapshot.autoStartEligible
      && captured?.policyAllowsAutoStart && persisted.snapshot.canStart) {
      return this.approve({
        workItemId: input.workItemId,
        proposalId: persisted.snapshot.proposalId,
        expectedProposalRevision: persisted.snapshot.proposalRevision,
      });
    }
    return persisted.snapshot;
  }

  async approve(input: { workItemId: string; proposalId: string;
    expectedProposalRevision: number }): Promise<TaskGraphPlanSnapshotView> {
    let proposal = this.repo.get(input.proposalId);
    this.assertProposalInput(proposal, input);
    if (["running", "completed"].includes(proposal.state)) return proposal;
    const resumingStart = proposal.state === "starting";
    if (!resumingStart && (proposal.state !== "ready" || !proposal.canStart
      || !proposal.materializedRevisionId)) {
      throw new TaskGraphConflictError("graph plan is not ready to start", proposal);
    }
    if (!proposal.materializedRevisionId) {
      throw new TaskGraphValidationError("graph plan has no materialized revision");
    }
    const plan = this.repo.plan(proposal.proposalId);
    const staged = this.repo.source(proposal.proposalId);
    if (!staged) throw new TaskGraphValidationError("graph plan has no frozen source snapshot");
    const authority = await this.requireAuthority(proposal.workItemId, proposal.primaryRunKey);
    const compiled = compileSemanticGraphPlan({
      workItemId: proposal.workItemId,
      workspaceId: authority.workspaceId,
      primaryRunKey: proposal.primaryRunKey,
      proposalRevision: proposal.proposalRevision,
      plan,
      defaultHarness: authority.harnessName,
      defaultAllowedTools: [...authority.allowedTools],
      validateNodePolicy: this.options.taskGraphs.options.validateNodePolicy,
    });
    if (!resumingStart) {
      const current = await this.capture(compiled.revision.revisionId,
        Object.fromEntries(proposal.steps.map((step) => [step.key, step.nodeId!])),
        plan, authority, proposal.workItemId, proposal.primaryRunKey, this.now());
      if (current.fingerprint !== staged.fingerprint) {
        proposal = this.repo.transition({ proposalId: proposal.proposalId,
          expectedProposalRevision: proposal.proposalRevision,
          expectedProjectionRevision: proposal.revision, state: "stale",
          error: "Connected context, repository state, or execution policy changed. Refresh the plan." }, this.now());
        this.publish(proposal, "source_drift");
        throw new TaskGraphConflictError("graph plan source snapshot is stale", proposal);
      }
    }
    this.options.taskGraphs.createRevision(compiled.revision, this.now(),
      `plan-revision:${proposal.proposalId}`);
    const graphRunId = proposal.graphRunId ?? canonicalId("graph-run", {
      proposalId: proposal.proposalId,
      revisionId: compiled.revision.revisionId,
      sourceSnapshotId: staged.snapshot.id,
    });
    const workItem = this.options.db.prepare(`SELECT lifecycle_revision,current_run_key
      FROM work_items WHERE id=?`).get(proposal.workItemId) as Row | undefined;
    if (!workItem || workItem.current_run_key !== proposal.primaryRunKey) {
      throw new TaskGraphConflictError("stale canonical WorkItem authority", workItem ?? null);
    }
    if (!resumingStart) {
      proposal = this.repo.transition({ proposalId: proposal.proposalId,
        expectedProposalRevision: proposal.proposalRevision,
        expectedProjectionRevision: proposal.revision, state: "starting", graphRunId }, this.now());
      this.publish(proposal, "plan_starting");
    }
    try {
      const graph = await this.options.taskGraphs.startRun({
        id: graphRunId,
        workItemId: proposal.workItemId,
        primaryRunKey: proposal.primaryRunKey,
        revisionId: compiled.revision.revisionId,
        sourceSnapshot: staged.snapshot,
        expectedLifecycleRevision: Number(workItem.lifecycle_revision),
        requestId: `plan-start:${proposal.proposalId}`,
      });
      const state = graphState(graph.run.status);
      const reflected = this.repo.get(proposal.proposalId);
      if (reflected.state === state && reflected.graphRunId === graphRunId) return reflected;
      proposal = this.repo.transition({ proposalId: proposal.proposalId,
        expectedProposalRevision: proposal.proposalRevision,
        expectedProjectionRevision: reflected.revision, state, graphRunId }, this.now());
      this.publish(proposal, "plan_started");
      if (isTerminalState(state)) this.options.onTerminal?.(proposal);
      return proposal;
    } catch (error) {
      const latest = this.repo.get(proposal.proposalId);
      if (latest.state === "starting") {
        proposal = this.repo.transition({ proposalId: latest.proposalId,
          expectedProposalRevision: latest.proposalRevision,
          expectedProjectionRevision: latest.revision, state: "failed",
          graphRunId, error: error instanceof Error ? error.message : "Graph start failed" }, this.now());
        this.publish(proposal, "plan_start_failed");
        this.options.onTerminal?.(proposal);
      }
      throw error;
    }
  }

  reject(input: { workItemId: string; proposalId: string;
    expectedProposalRevision: number }): TaskGraphPlanSnapshotView {
    const proposal = this.repo.get(input.proposalId);
    this.assertProposalInput(proposal, input);
    if (proposal.state === "rejected") return proposal;
    if (["starting", "running", "completed"].includes(proposal.state)) {
      throw new TaskGraphConflictError("a started graph plan cannot be rejected", proposal);
    }
    const rejected = this.repo.transition({ proposalId: proposal.proposalId,
      expectedProposalRevision: proposal.proposalRevision,
      expectedProjectionRevision: proposal.revision, state: "rejected" }, this.now());
    this.publish(rejected, "plan_rejected");
    return rejected;
  }

  snapshot(workItemId: string, primaryRunKey?: string | null): TaskGraphPlanSnapshotView | null {
    return this.repo.latest(workItemId, primaryRunKey);
  }

  inspection(workItemId:string,primaryRunKey:string,
    selector:PlanningHistorySelector={}):PlanningInspection {
    return inspectPlanningHistory(this.repo,this.options.taskGraphs,workItemId,
      primaryRunKey,selector);
  }

  readArtifact(input: { workItemId: string; primaryRunKey: string; graphRunId?:string;
    artifactId: string;
    offset: number; maxBytes: number }): Record<string, unknown> {
    return readPlanningHistoryArtifact(this.repo,input);
  }

  cancel(input:{workItemId:string;primaryRunKey:string;runId:string;
    expectedRunRevision:number;requestId:string}):Promise<TaskGraphPlanSnapshotView> {
    return cancelPlanningGraphRun(this.repo,this.options.taskGraphs,input,
      (runId,status,revision)=>this.reflectGraphStatus(runId,status,revision));
  }

  acknowledgeTerminalWake(proposalId: string, graphRunId: string): void {
    this.repo.acknowledgeTerminalWake(proposalId, graphRunId, this.now());
  }

  private async capture(revisionId: string, nodeIdsByStepKey: Record<string, string>,
    plan: SemanticTaskGraphPlan, authority: PlanningSourceAuthority,
    workItemId: string, primaryRunKey: string, at: number): Promise<CapturedPlanningSource> {
    return this.captureSource({ workItemId, primaryRunKey, revisionId, plan, nodeIdsByStepKey,
      ...authority }, at);
  }

  private async recoverPersisted(): Promise<boolean> {
    let deferred = false;
    const rows = this.options.db.prepare(`SELECT proposal.id,graph.status graph_status,
      graph.revision graph_run_revision FROM task_graph_plan_proposals proposal
      LEFT JOIN task_graph_runs graph ON graph.id=proposal.graph_run_id
      WHERE proposal.state IN ('starting','running') OR (
        proposal.state IN ('completed','failed','cancelled')
        AND proposal.terminal_wake_delivered_at IS NULL)
      ORDER BY proposal.updated_at`)
      .all() as Row[];
    for (const row of rows) {
      const proposal = this.repo.get(String(row.id));
      if (isTerminalState(proposal.state)) {
        this.options.onTerminal?.(proposal);
        continue;
      }
      if (typeof row.graph_status === "string") {
        this.reflectGraphStatus(
          proposal.graphRunId!, String(row.graph_status), Number(row.graph_run_revision ?? 0),
        );
        continue;
      }
      if (proposal.state !== "starting") continue;
      try {
        await this.approve({ workItemId: proposal.workItemId,
          proposalId: proposal.proposalId,
          expectedProposalRevision: proposal.proposalRevision });
      } catch (error) {
        deferred = true;
        log.warn("planning_start_recovery_deferred", {
          proposalId: proposal.proposalId, workItemId: proposal.workItemId, error,
        });
      }
    }
    return deferred;
  }

  private async requireAuthority(workItemId: string, primaryRunKey: string):
  Promise<PlanningSourceAuthority> {
    const value = await this.options.resolveSourceAuthority(workItemId, primaryRunKey);
    if (!value) throw new TaskGraphValidationError("planning source authority is unavailable");
    return value;
  }

  private assertProposalInput(proposal: TaskGraphPlanSnapshotView,
    input: { workItemId: string; expectedProposalRevision: number }): void {
    if (proposal.workItemId !== input.workItemId) {
      throw new TaskGraphValidationError("graph-plan proposal belongs to another WorkItem");
    }
    if (proposal.proposalRevision !== input.expectedProposalRevision) {
      throw new TaskGraphConflictError("stale graph-plan proposal revision", proposal);
    }
  }

  private reflectGraphStatus(runId: string, rawStatus: string, runRevision: number): void {
    let proposal = this.repo.proposalForRun(runId);
    if (!proposal) return;
    const state = graphState(rawStatus);
    if (proposal.state !== state) {
      proposal = this.repo.transition({ proposalId: proposal.proposalId,
        expectedProposalRevision: proposal.proposalRevision,
        expectedProjectionRevision: proposal.revision, state, graphRunId: runId }, this.now());
      this.publish(proposal, "graph_status_changed");
      if (isTerminalState(state)) this.options.onTerminal?.(proposal);
    }
    if (rawStatus === "blocked") {
      const token = `${rawStatus}:${runRevision}`;
      if (this.attentionTokens.get(runId) !== token) {
        this.attentionTokens.set(runId, token);
        this.options.onAttention?.(proposal, "blocked", runRevision);
      }
    } else {
      this.attentionTokens.delete(runId);
    }
  }

  private publish(snapshot: TaskGraphPlanSnapshotView, cause: string): void {
    this.options.bus.emitToWorkItem?.(snapshot.workItemId, {
      type: "task_graph_plan_changed",
      workItemId: snapshot.workItemId,
      revision: snapshot.revision,
      cause,
      snapshot,
      timestamp: this.now(),
    });
  }
}

function graphState(status: string): TaskGraphPlanState {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "running";
}

function isTerminalState(state: TaskGraphPlanState): boolean {
  return ["completed", "failed", "cancelled"].includes(state);
}
