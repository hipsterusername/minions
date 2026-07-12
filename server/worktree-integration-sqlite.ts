import crypto from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Bus } from "./bus.ts";
import type { PlannedWorktree } from "./worktree-create.ts";
import { resolveWorktreeBase } from "./worktree.ts";
import { getWorkItem } from "./work-item-repo.ts";
import * as repo from "./worktree-integration-repo.ts";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import { WorktreeIntegrationServiceError, type WorktreeIntegrationService } from "./worktree-integration-service.ts";
import { executeIntegrationCommand, IntegrationIdempotencyMismatchError } from "./worktree-integration-ledger.ts";
import { adoptLegacyContribution, transitionContributionProvisioning,
  waiveContributionGate, waiveLineageGate, discardContribution,
  recordConflictStrategy, attachLineageResolutionRun, completeLineageResolutionRun,
  failLineageResolutionRun, getLineageResolutionRun } from "./worktree-integration-operations.ts";
import { collectGitContribution } from "./git-integration-executor.ts";
import { joinWorkItemLineage } from "./worktree-lineage-membership-repo.ts";
import { evaluateMergeGatesForContext, type MergeGateVerdict } from "./system-model/gates.ts";
import { snapshotWorktreeLineage as snapshot } from "./worktree-integration-snapshot.ts";

const id = (kind: string, seed: string) => `${kind}-${crypto.createHash("sha256")
  .update(`${kind}\0${seed}`).digest("hex").slice(0, 24)}`;

export class SqliteWorktreeIntegrationService implements WorktreeIntegrationService {
  constructor(private readonly db: Database.Database, private readonly now = Date.now,
    private readonly resolveBase: typeof resolveWorktreeBase = resolveWorktreeBase,
    private readonly collectContribution: typeof collectGitContribution = collectGitContribution,
    private readonly bus?: Bus,
    private readonly evaluateGates: typeof evaluateMergeGatesForContext = evaluateMergeGatesForContext) {}
  private queueNotifier: ((repositoryPath: string, targetRef: string) => void) | undefined;
  private workItemNotifier: ((workItemId: string, cause: string) => void) | undefined;
  setQueueNotifier(notifier: (repositoryPath: string, targetRef: string) => void): void {
    this.queueNotifier = notifier;
  }
  setWorkItemNotifier(notifier: (workItemId: string, cause: string) => void): void {
    this.workItemNotifier = notifier;
  }
  refresh(lineageId: string, operation = "worker_transition"): WorktreeLineageSnapshot {
    const value = this.state(lineageId); this.publish(value, operation); return value;
  }
  private state(lineageId: string) { const value = snapshot(this.db, repo.getLineageState(this.db, lineageId));
    if (!value) throw new WorktreeIntegrationServiceError("not_found", "Lineage not found"); return value; }
  private command(requestId: string, command: string, payload: unknown,
    execute: () => WorktreeLineageSnapshot): WorktreeLineageSnapshot {
    try { const result = executeIntegrationCommand(this.db,
      { requestId, command, payload, at: this.now() }, execute).value;
      this.publish(result, command); return result;
    } catch (error) { if (error instanceof WorktreeIntegrationServiceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const contribution = typeof record["contributionId"] === "string"
        ? repo.getContribution(this.db, record["contributionId"] as string) : undefined;
      const lineageId = typeof record["lineageId"] === "string" ? record["lineageId"] as string
        : contribution?.lineage_id; const latest = lineageId
          ? snapshot(this.db, repo.getLineageState(this.db, lineageId)) : null;
      const code = error instanceof IntegrationIdempotencyMismatchError || /stale|revision|concurrent/i.test(message)
        ? "conflict" : /not found/i.test(message) ? "not_found"
          : /gate/i.test(message) ? "gate_failed"
            : /required|illegal|terminal|cannot|must/i.test(message) ? "invalid_state" : "internal";
      throw new WorktreeIntegrationServiceError(code, message, latest);
    }
  }
  private gatedCommand(requestId: string, command: string, payload: unknown,
    execute: () => { value: WorktreeLineageSnapshot; blocked?: string }): WorktreeLineageSnapshot {
    const result = executeIntegrationCommand(this.db,
      { requestId, command, payload, at: this.now() }, execute).value;
    this.publish(result.value, command);
    if (result.blocked) throw new WorktreeIntegrationServiceError("gate_failed", result.blocked, result.value);
    return result.value;
  }
  private publish(lineage: WorktreeLineageSnapshot, operation: string): void {
    const affected = new Set(lineage.memberships.map((entry) => entry.workItemId));
    for (const workItemId of affected) try { this.workItemNotifier?.(workItemId, operation); } catch { /* observer */ }
    if (!this.bus) return;
    const payload = { type: "worktree_integration_changed", operation, workItemId: null,
      lineage, timestamp: this.now() } as const;
    try { this.bus.emitToLineage?.(lineage.id, payload); } catch { /* observer */ }
    try { this.bus.emitToProject(lineage.projectId, payload); } catch { /* observer */ }
    for (const workItemId of affected) try { this.bus.emitToWorkItem?.(workItemId,
      { ...payload, workItemId }); } catch { /* observer */ }
  }
  transitionProvisioning(runKey: string, outcome: "provisioning" | "active" | "failed", error?: string): void {
    const row = repo.findContributionByRun(this.db, runKey); if (!row) return;
    if ((outcome === "provisioning" && row.state !== "planned")
      || (outcome !== "provisioning" && !["planned", "provisioning"].includes(row.state))) return;
    const changed = transitionContributionProvisioning(this.db, { contributionId: row.id,
      expectedRevision: row.revision, outcome, actor: "runtime", ...(error ? { error } : {}), at: this.now() });
    this.publish(this.state(changed.lineage_id), `contribution_${outcome}`);
  }
  async collectRun(runKey: string, outcome: "completed" | "error" | "interrupted"): Promise<void> {
    const resolution = getLineageResolutionRun(this.db, runKey);
    if (resolution) {
      if (outcome === "error") { failLineageResolutionRun(this.db, { runKey,
        expectedRunRevision: resolution.revision, error: "resolution run failed",
        actor: "runtime", at: this.now() }); return; }
      const lineage = repo.getLineage(this.db, resolution.lineage_id); if (!lineage) return;
      const headSha = await this.collectContribution({ repositoryPath: lineage.repository_path,
        worktreePath: lineage.integration_worktree_path, sourceRef: lineage.integration_ref,
        message: `minions: resolve lineage ${lineage.id}` });
      completeLineageResolutionRun(this.db, { runKey, expectedRunRevision: resolution.revision,
        expectedLineageRevision: lineage.revision, integrationHeadSha: headSha,
        actor: "runtime", at: this.now() }); this.refresh(lineage.id, "lineage_conflict_resolved"); return;
    }
    const row = repo.findContributionByRun(this.db, runKey);
    if (!row || row.state !== "active" || outcome === "error") return;
    const lineage = repo.getLineage(this.db, row.lineage_id); if (!lineage) return;
    const headSha = await this.collectContribution({ repositoryPath: lineage.repository_path,
      worktreePath: row.worktree_path, sourceRef: row.branch_name,
      message: `minions: collect ${row.work_item_id} ${runKey}` });
    const changed = repo.setContributionHead(this.db, { contributionId: row.id, headSha,
      expectedRevision: row.revision, at: this.now(), actor: "runtime" });
    this.publish(this.state(changed.lineage_id), "contribution_ready");
  }
  async recoverTerminalContributions(): Promise<string[]> {
    const rows = this.db.prepare(`SELECT r.run_key,s.run_outcome FROM worktree_contribution_runs r
      JOIN worktree_contributions c ON c.id=r.contribution_id JOIN sessions s ON s.session_key=r.run_key
      WHERE c.state='active' AND s.ended_at IS NOT NULL
      AND s.run_outcome IN ('completed','interrupted') UNION SELECT r.run_key,s.run_outcome
      FROM worktree_lineage_resolution_runs r JOIN sessions s ON s.session_key=r.run_key
      WHERE r.state='active' AND s.ended_at IS NOT NULL
      AND s.run_outcome IN ('completed','interrupted','error')`).all() as
      Array<{ run_key: string; run_outcome: "completed" | "interrupted" | "error" }>;
    for (const row of rows) await this.collectRun(row.run_key, row.run_outcome);
    return rows.map((row) => row.run_key);
  }
  async createLineage(input: { requestId: string; workItemId: string; targetBranch?: string }) {
    const item = getWorkItem(this.db, input.workItemId); if (!item) throw new WorktreeIntegrationServiceError("not_found", "Work item not found");
    const existing = repo.findOpenLineageByWorkItem(this.db, item.id); if (existing) return this.state(existing.id);
    const base = await this.resolveBase(item.project_path, input.targetBranch); const lineageId = id("lineage", input.requestId);
    return this.command(input.requestId, "create_lineage", input, () => { repo.createLineage(this.db,
      { id: lineageId, projectId: item.project_id, repositoryPath: item.project_path,
        targetRef: base.targetRef, baseSha: base.baseSha,
        integrationRef: `refs/heads/minions/integration/${lineageId}`,
        integrationWorktreePath: path.join(item.project_path, ".canvas-worktrees", `integration-${lineageId}`),
        at: this.now(), actor: "user" });
      joinWorkItemLineage(this.db, { lineageId, workItemId: item.id,
        expectedLineageRevision: 0, actor: "user", at: this.now() });
      return this.state(lineageId); });
  }
  async joinLineage(input: { requestId: string; workItemId: string; lineageId: string;
    expectedRevision: number; actor: string }) {
    return this.command(input.requestId, "join_lineage", input, () => {
      joinWorkItemLineage(this.db, { lineageId: input.lineageId, workItemId: input.workItemId,
        expectedLineageRevision: input.expectedRevision, actor: input.actor, at: this.now() });
      return this.state(input.lineageId);
    });
  }
  async bindRun(input: { workItemId: string; runKey: string; lineageId?: string }): Promise<PlannedWorktree & {
    resolutionTargetRef?: string; resolutionKind?: "contribution" | "lineage" }> {
    const priorLineageResolution = getLineageResolutionRun(this.db, input.runKey);
    if (priorLineageResolution) { const lineage = repo.getLineage(this.db, priorLineageResolution.lineage_id)!;
      return { path: lineage.integration_worktree_path,
        branch: lineage.integration_ref.replace(/^refs\/heads\//, ""),
        projectPath: lineage.repository_path, leaderSessionKey: input.runKey,
        createdAt: lineage.created_at, lifecycle: "active",
        resolutionTargetRef: lineage.target_ref, resolutionKind: "lineage" }; }
    const prior = repo.findContributionByRun(this.db, input.runKey); if (prior) {
      const lineage = repo.getLineage(this.db, prior.lineage_id)!; return { path: prior.worktree_path,
        branch: prior.branch_name, projectPath: lineage.repository_path, leaderSessionKey: input.runKey,
        createdAt: prior.created_at, lifecycle: prior.state === "active" ? "active" : "initializing" };
    }
    const item = getWorkItem(this.db, input.workItemId); if (!item) throw new Error("work item not found");
    let lineage = input.lineageId ? repo.getLineage(this.db, input.lineageId) : repo.findOpenLineageByWorkItem(this.db, item.id);
    if (lineage?.integration_state === "conflicted") {
      attachLineageResolutionRun(this.db, { lineageId: lineage.id, workItemId: item.id,
        runKey: input.runKey, expectedLineageRevision: lineage.revision, actor: "runtime", at: this.now() });
      return { path: lineage.integration_worktree_path,
        branch: lineage.integration_ref.replace(/^refs\/heads\//, ""),
        projectPath: lineage.repository_path, leaderSessionKey: input.runKey,
        createdAt: lineage.created_at, lifecycle: "active",
        resolutionTargetRef: lineage.target_ref, resolutionKind: "lineage" };
    }
    if (!lineage && !input.lineageId) {
      const legacy = this.db.prepare(`SELECT session_key,worktree_path,worktree_branch,
        worktree_project_path,worktree_created_at FROM sessions WHERE work_item_id=?
        AND worktree_path IS NOT NULL AND worktree_branch IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`).get(item.id) as { session_key: string;
          worktree_path: string; worktree_branch: string; worktree_project_path: string | null;
          worktree_created_at: number | null } | undefined;
      if (legacy && !repo.findContributionByRun(this.db, legacy.session_key)) {
        const base = await this.resolveBase(legacy.worktree_project_path ?? item.project_path);
        const lineageId = id("lineage", `legacy:${legacy.session_key}`);
        repo.createLineage(this.db, { id: lineageId, projectId: item.project_id,
          repositoryPath: legacy.worktree_project_path ?? item.project_path,
          targetRef: base.targetRef, baseSha: base.baseSha,
          integrationRef: `refs/heads/minions/integration/${lineageId}`,
          integrationWorktreePath: path.join(item.project_path, ".canvas-worktrees", `integration-${lineageId}`),
          at: this.now(), actor: "migration" });
        joinWorkItemLineage(this.db, { lineageId, workItemId: item.id,
          expectedLineageRevision: 0, actor: "migration", at: this.now() });
        const existingHead = await this.resolveBase(legacy.worktree_project_path ?? item.project_path,
          `refs/heads/${legacy.worktree_branch}`);
        adoptLegacyContribution(this.db, { id: id("contribution", `legacy:${legacy.session_key}`),
          lineageId, workItemId: item.id, runKey: legacy.session_key,
          branchName: legacy.worktree_branch, worktreePath: legacy.worktree_path,
          baseSha: existingHead.baseSha, headSha: existingHead.baseSha,
          at: legacy.worktree_created_at ?? this.now(), actor: "migration" });
        lineage = repo.getLineage(this.db, lineageId);
      }
    }
    if (lineage) {
      const contributions = [...repo.getLineageState(this.db, lineage.id).contributions].reverse();
      const conflicted = contributions
        .find((entry) => entry.work_item_id === item.id && entry.state === "conflicted");
      if (conflicted) {
        const row = repo.attachResolutionRun(this.db, { contributionId: conflicted.id,
          runKey: input.runKey, expectedRevision: conflicted.revision, at: this.now(), actor: "runtime" });
        return { path: row.worktree_path, branch: row.branch_name, projectPath: lineage.repository_path,
          leaderSessionKey: input.runKey, createdAt: row.created_at, lifecycle: "active",
          resolutionTargetRef: lineage.integration_ref, resolutionKind: "contribution" };
      }
      const editable = contributions.find((entry) => entry.work_item_id === item.id
        && ["active", "ready", "failed"].includes(entry.state));
      if (editable) {
        const row = repo.attachContributionIteration(this.db, { contributionId: editable.id,
          runKey: input.runKey, expectedRevision: editable.revision, at: this.now(), actor: "runtime" });
        return { path: row.worktree_path, branch: row.branch_name, projectPath: lineage.repository_path,
          leaderSessionKey: input.runKey, createdAt: row.created_at, lifecycle: "active" };
      }
    }
    if (!lineage) { const created = await this.createLineage({ requestId: `auto:${input.runKey}`, workItemId: item.id });
      lineage = repo.getLineage(this.db, created.id); }
    if (!lineage) throw new Error("open lineage allocation failed");
    const contributionId = id("contribution", input.runKey); const branch = `minions/contribution/${contributionId}`;
    const worktreePath = path.join(lineage.repository_path, ".canvas-worktrees", contributionId);
    const row = repo.addContribution(this.db, { id: contributionId, lineageId: lineage.id,
      workItemId: item.id, runKey: input.runKey, branchName: branch, worktreePath,
      baseSha: lineage.integration_head_sha ?? lineage.base_sha,
      state: "planned", at: this.now(), actor: "runtime" });
    return { path: row.worktree_path, branch: row.branch_name, projectPath: lineage.repository_path,
      leaderSessionKey: input.runKey, createdAt: row.created_at };
  }
  async reviewContribution(input: { requestId: string; contributionId: string; expectedRevision: number;
    decision: "approved" | "rejected"; actor: string; summary: string }) {
    const before = repo.getContribution(this.db, input.contributionId);
    if (!before || before.revision !== input.expectedRevision) throw new WorktreeIntegrationServiceError("conflict", "stale contribution revision");
    const lineage = repo.getLineage(this.db, before.lineage_id)!;
    const verdict = await this.evaluateGates({ worktree: { path: before.worktree_path,
      branch: before.branch_name, leaderSessionKey: before.originating_run_key,
      createdAt: before.created_at, projectPath: lineage.repository_path, lifecycle: "active" },
      cwd: before.worktree_path, sessionKey: before.originating_run_key });
    return this.gatedCommand(input.requestId, "review_contribution", input, () => {
      let current = repo.getContribution(this.db, input.contributionId);
      if (!current || current.revision !== input.expectedRevision || current.head_sha !== before.head_sha)
        throw new Error("stale contribution revision or head");
      this.persistContributionGates(current, verdict, input.requestId); current = repo.getContribution(this.db, current.id)!;
      if (input.decision === "approved" && verdict.mode === "enforced" && !verdict.allowed) return {
        value: this.state(current.lineage_id), blocked: "contribution gates failed" };
      const row = repo.recordContributionReview(this.db, { id: id("review", input.requestId),
        contributionId: current.id, expectedRevision: current.revision, decision: input.decision,
        actor: input.actor, notes: input.summary, at: this.now() }); return { value: this.state(row.lineage_id) }; }); }

  private persistContributionGates(row: repo.ContributionRow, verdict: MergeGateVerdict, seed: string): void {
    for (const gate of verdict.gates) repo.recordGate(this.db, { id: id("gate", `${seed}:${gate.id}`),
      contributionId: row.id, name: gate.id, status: verdict.mode === "advisory"
        && ["required_pending", "failed"].includes(gate.status) ? "waived"
        : gate.status === "not_required" ? "passed" : gate.status === "required_pending" ? "pending" : gate.status,
      details: { name: gate.name, reason: gate.reason, mode: verdict.mode,
        ...(verdict.mode === "advisory" ? { advisoryStatus: gate.status } : {}) }, at: this.now() });
  }
  async enqueueContribution(input: { requestId: string; contributionId: string; expectedRevision: number }) {
    const row = repo.getContribution(this.db, input.contributionId); if (!row || row.revision !== input.expectedRevision) throw new Error("stale contribution revision");
    const result = this.command(input.requestId, "enqueue_contribution", input, () => { repo.enqueueContribution(this.db,
      { id: id("queue", input.requestId), lineageId: row.lineage_id,
        contributionId: row.id, idempotencyKey: input.requestId, at: this.now() }); return this.state(row.lineage_id); });
    const queued = result.queue.find((entry) => entry.state === "queued" && entry.contributionId === row.id);
    if (queued) this.queueNotifier?.(queued.repositoryPath, queued.targetRef); return result; }
  async retryContribution(input: { requestId: string; contributionId: string; expectedRevision: number }) {
    const row = repo.getContribution(this.db, input.contributionId); if (!row || row.revision !== input.expectedRevision) throw new Error("stale contribution revision");
    const state = repo.getLineageState(this.db, row.lineage_id); const prior = [...state.queue].reverse()
      .find((entry) => entry.contribution_id === row.id && ["failed","conflicted","cancelled"].includes(entry.state));
    if (!prior) throw new Error("retryable queue entry not found"); const result = this.command(input.requestId,
      "retry_contribution", input, () => { repo.retryIntegration(this.db,
        { priorQueueId: prior.id, id: id("queue", input.requestId), idempotencyKey: input.requestId, at: this.now() }); return this.state(row.lineage_id); });
    const queued = result.queue.find((entry) => entry.state === "queued" && entry.contributionId === row.id);
    if (queued) this.queueNotifier?.(queued.repositoryPath, queued.targetRef); return result; }
  async discardContribution(input: { requestId: string; contributionId: string; expectedRevision: number; reason?: string }) {
    return this.command(input.requestId, "discard_contribution", input, () => { const row = discardContribution(this.db,
      { contributionId: input.contributionId, expectedRevision: input.expectedRevision,
        actor: "user", reason: input.reason ?? "discarded", at: this.now() }); return this.state(row.lineage_id); }); }
  async reviewFinal(input: { requestId: string; lineageId: string; expectedRevision: number;
    decision: "approved" | "rejected"; actor: string; summary: string }) {
    const before = repo.getLineage(this.db, input.lineageId);
    if (!before || before.revision !== input.expectedRevision) throw new WorktreeIntegrationServiceError("conflict", "stale lineage revision");
    const combined = await this.evaluateGates({ worktree: { path: before.integration_worktree_path,
      branch: before.integration_ref.replace(/^refs\/heads\//, ""), leaderSessionKey: before.id,
      createdAt: before.created_at, projectPath: before.repository_path, lifecycle: "active" },
      cwd: before.integration_worktree_path, sessionKey: before.id });
    const verdict = this.aggregateLineageGates(before.id, combined);
    return this.gatedCommand(input.requestId, "review_lineage", input, () => {
      let current = repo.getLineage(this.db, input.lineageId);
      if (!current || current.revision !== input.expectedRevision
        || current.integration_head_sha !== before.integration_head_sha) throw new Error("stale lineage revision or head");
      for (const gate of verdict.gates) repo.recordLineageGate(this.db, {
        id: id("gate", `${input.requestId}:${gate.id}`), lineageId: current.id, name: gate.id,
        status: verdict.mode === "advisory" && ["required_pending", "failed"].includes(gate.status)
          ? "waived" : gate.status === "not_required" ? "passed"
            : gate.status === "required_pending" ? "pending" : gate.status,
        details: { name: gate.name, reason: gate.reason, mode: verdict.mode,
          ...(verdict.mode === "advisory" ? { advisoryStatus: gate.status } : {}) }, at: this.now() });
      current = repo.getLineage(this.db, current.id)!;
      if (input.decision === "approved" && verdict.mode === "enforced" && !verdict.allowed) return {
        value: this.state(current.id), blocked: "lineage gates failed" };
      repo.recordLineageApproval(this.db, { id: id("review", input.requestId), lineageId: current.id,
        expectedRevision: current.revision, decision: input.decision,
        actor: input.actor, notes: input.summary, at: this.now() }); return { value: this.state(input.lineageId) }; }); }
  private aggregateLineageGates(lineageId: string, verdict: MergeGateVerdict): MergeGateVerdict {
    const integrated = repo.getLineageState(this.db, lineageId).contributions
      .filter((entry) => entry.state === "integrated");
    const gates = verdict.gates.map((gate) => { if (gate.status === "not_required") return gate;
      const rows = this.db.prepare(`SELECT contribution_id,status,details FROM worktree_integration_gates
        WHERE lineage_id=? AND scope='contribution' AND name=?`).all(lineageId, gate.id) as
        Array<{ contribution_id: string; status: string; details: string | null }>;
      const statuses = integrated.map((entry) => { const row = rows.find((item) => item.contribution_id === entry.id);
        if (!row || row.status !== "waived" || verdict.mode === "advisory") return row?.status;
        const detail = row.details ? JSON.parse(row.details) as { advisoryStatus?: string } : {};
        return detail.advisoryStatus ? "pending" : "waived"; });
      const status = statuses.some((value) => value === "failed") ? "failed" as const
        : integrated.length > 0 && statuses.length === integrated.length
          && statuses.every((value) => value === "passed" || value === "waived")
          ? "passed" as const : "required_pending" as const;
      return { ...gate, status, reason: status === "passed"
        ? "All integrated contributions satisfied this gate." : "Contribution gate results are incomplete or failed." }; });
    return { ...verdict, gates, allowed: !gates.some((gate) =>
      gate.status === "required_pending" || gate.status === "failed") };
  }
  async waiveGate(input: { requestId: string; scope: "contribution" | "lineage"; contributionId?: string;
    lineageId: string; gateId: string; expectedRevision: number; actor: string; reason: string }) {
    return this.command(input.requestId, "waive_gate", input, () => {
      if (input.scope === "contribution") { const row = input.contributionId
        ? repo.getContribution(this.db, input.contributionId) : undefined;
        if (!row || row.lineage_id !== input.lineageId || row.revision !== input.expectedRevision)
          throw new Error("stale contribution revision");
        waiveContributionGate(this.db, { lineageId: input.lineageId, contributionId: row.id,
          name: input.gateId, actor: input.actor, reason: input.reason, at: this.now() });
      } else { const lineage = repo.getLineage(this.db, input.lineageId);
        if (!lineage || lineage.revision !== input.expectedRevision) throw new Error("stale lineage revision");
        waiveLineageGate(this.db, { lineageId: lineage.id, name: input.gateId,
          actor: input.actor, reason: input.reason, at: this.now() }); }
      return this.state(input.lineageId); }); }
  async resolveConflict(input: { requestId: string; contributionId: string; queueId: string;
    expectedRevision: number; strategy: "manual" | "ours" | "theirs"; actor: string; reason: string }) {
    return this.command(input.requestId, "resolve_conflict", input, () => { const row = repo.getContribution(this.db, input.contributionId);
      if (!row || row.state !== "conflicted" || row.revision !== input.expectedRevision) throw new Error("stale conflicted contribution revision");
      const queue = repo.getQueueEntry(this.db, input.queueId); if (!queue || queue.contribution_id !== row.id || queue.state !== "conflicted") throw new Error("conflicted queue entry required");
      recordConflictStrategy(this.db,
      { contributionId: row.id, strategy: input.strategy,
        actor: input.actor, reason: input.reason, at: this.now() }); return this.state(row.lineage_id); }); }
  async promote(input: { requestId: string; lineageId: string; expectedRevision: number }) {
    const row = repo.getLineage(this.db, input.lineageId); if (!row || row.revision !== input.expectedRevision) throw new Error("stale lineage revision");
    const target = await this.resolveBase(row.repository_path, row.target_ref);
    const result = this.command(input.requestId, "promote_lineage", input, () => { repo.enqueueLineage(this.db,
      { id: id("queue", input.requestId), lineageId: row.id,
        idempotencyKey: input.requestId, expectedTargetSha: target.baseSha,
        at: this.now() }); return this.state(row.id); });
    const queued = result.queue.find((entry) => entry.state === "queued" && entry.kind === "lineage");
    if (queued) this.queueNotifier?.(queued.repositoryPath, queued.targetRef); return result; }
  async getStatus(input: { lineageId?: string; workItemId?: string; runKey?: string }) { const contribution = input.runKey
    ? repo.findContributionByRun(this.db, input.runKey) : undefined; const lineage = input.lineageId
    ? repo.getLineage(this.db, input.lineageId) : contribution ? repo.getLineage(this.db, contribution.lineage_id)
      : input.workItemId ? repo.findLatestLineageByWorkItem(this.db, input.workItemId) : undefined;
    return lineage ? this.state(lineage.id) : null; }
}
