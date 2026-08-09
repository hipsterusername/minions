import type Database from "better-sqlite3";
import type { Bus } from "./bus.ts";
import {
  workItemDetailSnapshotSchema,
  workItemListSnapshotSchema,
  workItemRunListSnapshotSchema,
  type WorkItemBindingSnapshot,
  type WorkItemDetailSnapshot,
  type WorkItemRunSnapshot,
} from "../shared/work-item-contracts.ts";
import type { Outcome, WorkItemWaitKind } from "../shared/work-item-lifecycle.ts";
import type { ThinkingConfig } from "./session-host-config.ts";
import {
  WorkItemConflictError,
  createWorkItem,
  getWorkItem,
  getWorkItemRun,
  resumeWaitingWorkItemRun,
  sealWorkItemRun,
  startWorkItemIteration,
  waitWorkItemRun,
} from "./work-item-repo.ts";
import { updateRunProviderSessionId } from "./work-item-provider-repo.ts";
import { createChildWorkItemRun, sealChildWorkItemRun } from "./work-item-child-repo.ts";
import { attachWorkItemBinding, detachWorkItemBinding } from "./work-item-binding-repo.ts";
import { getRunByStartRequest, listWorkItemBindings, listWorkItemRunsPage, listWorkItemsPage } from "./work-item-query-repo.ts";
import { WorkItemServiceError, type WorkItemService } from "./work-item-service.ts";
import { executeWorkItemCommand, findCommandResult } from "./work-item-command-ledger.ts";
import { emitBindingChanged, emitItemChanged, emitRunChanged } from "./work-item-service-events.ts";
import { compatibleResumeId, resolvePrimaryRunConfig } from "./work-item-run-config.ts";
import { resolveWorkItemMutation } from "./work-item-archive.ts";
import { continueChildWorkItemRun, continueWorkItemIntent, type RunContinuationInput } from "./work-item-continuation.ts";
import { bindingSnapshot, itemSnapshot, runSnapshot } from "./work-item-snapshots.ts";
import { resolveWorkItemProjectIdentity } from "./work-item-project.ts";

export interface WorkItemInvocation {
  requestId?: string; workItemId: string; runKey: string; prompt: string; resumeId?: string;
  displayPrompt?: string;
  invocationKind: "new_run" | "resume_open_run";
  parentRunKey?: string; taskId?: string;
  systemPrompt?: string; model?: string; thinkingConfig?: ThinkingConfig;
  attachments?: import("./session-host-types.ts").ImageAttachment[];
  harness?: string; permissionMode?: string;
  sandboxPolicy?: import("../shared/workspace-contracts.ts").SandboxPolicy;
  executorClass?: "mechanical" | "standard" | "reasoning"; skillIds?: string[]; skillValues?: Record<string, Record<string, string>>;
  plannedContribution?: import("./worktree-create.ts").PlannedWorktree & { resolutionTargetRef?: string; resolutionKind?: "contribution" | "lineage" };
}
export interface SqliteWorkItemServiceOptions {
  db: Database.Database; bus: Bus;
  generateKey: (kind: "work_item" | "run", requestId: string) => string;
  launchRun: (input: WorkItemInvocation) => void | Promise<void>;
  ensureRunLaunched?: (input: WorkItemInvocation) => void | Promise<void>;
  ensureRunContinued?: (input: WorkItemInvocation & { requestId: string }) => void | Promise<void>;
  isRunLive?: (runKey: string) => boolean;
  stopRun?: (input: { workItemId: string; runKey: string }) => void | Promise<void>;
  queueRunGuidance?: (input: RunContinuationInput) => void | Promise<void>;
  continueRun: (input: WorkItemInvocation) => void | Promise<void>;
  bindWorktreeRun?: (input: { workItemId: string; runKey: string }) => void |
    import("./worktree-create.ts").PlannedWorktree | Promise<void | import("./worktree-create.ts").PlannedWorktree>;
  now?: () => number;
}
export class SqliteWorkItemService implements WorkItemService {
  readonly now: () => number; constructor(readonly options: SqliteWorkItemServiceOptions) {
    this.now = options.now ?? Date.now;
  }
  private detail(id: string, cursor?: string, limit = 50): WorkItemDetailSnapshot | null {
    const row = getWorkItem(this.options.db, id);
    if (!row) return null;
    const page = listWorkItemRunsPage(this.options.db, { workItemId: id, cursor, limit: Math.max(1, Math.min(limit, 100)) });
    const current = row.current_run_key ? getWorkItemRun(this.options.db, row.current_run_key) : null;
    return workItemDetailSnapshotSchema.parse({
      workItem: itemSnapshot(row),
      bindings: listWorkItemBindings(this.options.db, id).map(bindingSnapshot),
      currentRun: current ? runSnapshot(current) : null,
      runs: page.rows.map(runSnapshot),
      nextCursor: page.nextCursor,
    });
  }
  getSync(id: string): WorkItemDetailSnapshot | null { return this.detail(id); }
  latestOrThrow(id: string): WorkItemDetailSnapshot {
    const detail = this.detail(id);
    if (!detail) throw new WorkItemServiceError("not_found", `Work item ${id} not found`, null);
    return detail;
  }
  emit(detail: WorkItemDetailSnapshot, cause: string, at: number): void { emitItemChanged(this.options.bus, detail, cause, at); }
  private emitRun(type: "work_item_run_created" | "work_item_run_sealed", detail: WorkItemDetailSnapshot, run: WorkItemRunSnapshot, at: number): void { emitRunChanged(this.options.bus, type, detail, run, at); }
  private emitBinding(detail: WorkItemDetailSnapshot, binding: WorkItemBindingSnapshot, at: number): void { emitBindingChanged(this.options.bus, detail, binding, at); }
  translate(error: unknown, id: string): never {
    if (error instanceof WorkItemServiceError) throw error;
    const latest = this.detail(id);
    if (error instanceof WorkItemConflictError) {
      throw new WorkItemServiceError(error.latest ? "conflict" : "not_found", error.message, latest);
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /immutable|idempotency/i.test(message)
      ? "idempotency_mismatch"
      : /requires|cannot|illegal|invalid|archived/i.test(message)
        ? "invalid_transition"
        : "internal";
    throw new WorkItemServiceError(code, message, latest);
  }
  async create(input: Parameters<WorkItemService["create"]>[0]): Promise<WorkItemDetailSnapshot> {
    let id = "";
    try {
      const prior = findCommandResult(this.options.db, { requestId: input.requestId,
        command: "create", payload: input });
      id = prior ?? this.options.generateKey("work_item", input.requestId);
      executeWorkItemCommand(this.options.db, { requestId: input.requestId,
        workItemId: id, command: "create", payload: input, resultKey: id, at: this.now() }, () =>
        createWorkItem(this.options.db, {
          id, projectId: input.projectId, projectPath: input.projectPath,
          title: input.title, changeMode: input.changeMode,
          at: this.now(),
        }));
      const detail = this.latestOrThrow(id);
      const at = this.now();
      const payload = { type: "work_item_created", workItem: detail.workItem, timestamp: at };
      this.options.bus.emitToWorkItem?.(id, payload);
      this.options.bus.emitToProject(detail.workItem.projectId, payload);
      return detail;
    } catch (error) { return this.translate(error, id); }
  }
  continue(input: Parameters<WorkItemService["continue"]>[0]) { return continueWorkItemIntent(this, input); }
  async startRun(input: Parameters<WorkItemService["startRun"]>[0]): Promise<WorkItemDetailSnapshot> {
    const runKey = this.options.generateKey("run", input.requestId);
    const previous = input.expectedCurrentRunKey
      ? getWorkItemRun(this.options.db, input.expectedCurrentRunKey)
      : null;
    const inherited = previous?.run_config_json ?? (previous
      ? JSON.stringify({ harness: previous.harness_name, ...(previous.model ? { model: previous.model } : {}) })
      : null);
    const resolved = resolvePrimaryRunConfig(inherited, input);
    try {
      const ledger = executeWorkItemCommand(this.options.db, { requestId: input.requestId,
        workItemId: input.workItemId, command: "start_run", payload: input, at: this.now() }, () =>
        startWorkItemIteration(this.options.db, {
          workItemId: input.workItemId, runKey, idempotencyKey: input.requestId,
          expectedLifecycleRevision: input.expectedLifecycleRevision,
          expectedCurrentRunKey: input.expectedCurrentRunKey,
          runConfigJson: resolved.json, at: this.now(),
        }));
      const started = ledger.value ?? { workItem: getWorkItem(this.options.db, input.workItemId)!,
        run: getRunByStartRequest(this.options.db, input.workItemId, input.requestId), idempotent: true };
      let detail = this.latestOrThrow(input.workItemId);
      if (!started.idempotent) {
        this.emit(detail, "run_started", this.now());
        this.emitRun("work_item_run_created", detail, runSnapshot(started.run!), this.now());
      } else {
        this.emit(detail, "run_start_replayed", this.now());
        this.emitRun(started.run!.ended_at === null ? "work_item_run_created" : "work_item_run_sealed",
          detail, runSnapshot(started.run!), this.now());
      }
      if (started.run!.ended_at !== null) return detail;
      try {
        const { config } = resolvePrimaryRunConfig(started.run!.run_config_json, {});
        const resumeId = compatibleResumeId(previous, config);
        const plannedContribution = started.workItem.change_mode === "worktree"
          ? await this.options.bindWorktreeRun?.({ workItemId: input.workItemId,
              runKey: started.run!.session_key }) : undefined;
        await (this.options.ensureRunLaunched ?? this.options.launchRun)({
          workItemId: input.workItemId, runKey: started.run!.session_key,
          prompt: input.prompt, invocationKind: "new_run",
          ...(input.displayPrompt ? { displayPrompt: input.displayPrompt } : {}),
          ...(resumeId ? { resumeId } : {}), ...(plannedContribution ? { plannedContribution } : {}), ...config,
        });
      } catch (launchError) {
        const message = launchError instanceof Error ? launchError.message : String(launchError);
        if (this.options.isRunLive?.(started.run!.session_key)) {
          throw new WorkItemServiceError("internal", `Launch acknowledgement failed for live run: ${message}`, detail);
        }
        sealWorkItemRun(this.options.db, {
          workItemId: input.workItemId, runKey: started.run!.session_key,
          outcome: "error", finalReport: message,
          expectedLifecycleRevision: started.workItem.lifecycle_revision,
          expectedCurrentRunKey: started.run!.session_key, at: this.now(),
        });
        detail = this.latestOrThrow(input.workItemId);
        this.emit(detail, "run_launch_failed", this.now());
        this.emitRun("work_item_run_sealed", detail, detail.currentRun!, this.now());
        throw new WorkItemServiceError("internal", `Run launch failed: ${message}`, detail);
      }
      return detail;
    } catch (error) { return this.translate(error, input.workItemId); }
  }

  async replyToWaitingRun(input: Parameters<WorkItemService["replyToWaitingRun"]>[0]): Promise<WorkItemDetailSnapshot> {
    try {
      const ledger = executeWorkItemCommand(this.options.db, {
        requestId: input.requestId, workItemId: input.workItemId,
        command: "reply", payload: { workItemId: input.workItemId,
          runKey: input.runKey, prompt: input.prompt }, at: this.now(),
      }, () => resumeWaitingWorkItemRun(this.options.db, {
        workItemId: input.workItemId, runKey: input.runKey,
        expectedLifecycleRevision: input.expectedLifecycleRevision,
        expectedCurrentRunKey: input.expectedCurrentRunKey as string, at: this.now(),
      }));
      const resumed = ledger.value ?? { workItem: getWorkItem(this.options.db, input.workItemId)!, run: getWorkItemRun(this.options.db, input.runKey) };
      let detail = this.latestOrThrow(input.workItemId);
      this.emit(detail, ledger.idempotent ? "reply_replayed" : "run_resumed", this.now());
      if (resumed.run?.ended_at !== null) {
        this.emit(detail, "reply_replayed_terminal", this.now());
        if (resumed.run) this.emitRun("work_item_run_sealed", detail, runSnapshot(resumed.run), this.now());
        return detail;
      }
      try {
        const continuation = {
          workItemId: input.workItemId, runKey: input.runKey, prompt: input.prompt,
          invocationKind: "resume_open_run",
          ...(input.displayPrompt ? { displayPrompt: input.displayPrompt } : {}),
          ...(resumed.run?.session_id ? { resumeId: resumed.run.session_id } : {}),
          requestId: input.requestId,
        } as const;
        await (this.options.ensureRunContinued ?? this.options.continueRun)(continuation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.options.isRunLive?.(input.runKey)) {
          throw new WorkItemServiceError("internal", `Continuation acknowledgement failed for live run: ${message}`, detail);
        }
        sealWorkItemRun(this.options.db, {
          workItemId: input.workItemId, runKey: input.runKey, outcome: "error",
          finalReport: message, expectedLifecycleRevision: resumed.workItem.lifecycle_revision,
          expectedCurrentRunKey: input.runKey, at: this.now(),
        });
        detail = this.latestOrThrow(input.workItemId);
        this.emit(detail, "run_resume_failed", this.now());
        throw new WorkItemServiceError("internal", `Run resume failed: ${message}`, detail);
      }
      return detail;
    } catch (error) { return this.translate(error, input.workItemId); }
  }
  async resumePrimaryRun(input: RunContinuationInput): Promise<WorkItemDetailSnapshot> {
    const detail = this.latestOrThrow(input.workItemId);
    return this.replyToWaitingRun({ ...input,
      expectedLifecycleRevision: detail.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: detail.workItem.currentRunKey });
  }

  async continueChildRun(input: RunContinuationInput): Promise<void> {
    try {
      await continueChildWorkItemRun({ db: this.options.db, now: this.now,
        continueRun: this.options.ensureRunContinued ?? this.options.continueRun }, input);
    } catch (error) { return this.translate(error, input.workItemId); }
  }

  async review(input: Parameters<WorkItemService["review"]>[0]) { return this.resolve(input, "review"); }
  async archive(input: Parameters<WorkItemService["archive"]>[0]) { return this.resolve(input, "archive"); }
  async restore(input: Parameters<WorkItemService["restore"]>[0]) { return this.resolve(input, "restore"); }

  private async resolve(input: Parameters<WorkItemService["review"]>[0], kind: "review" | "archive" | "restore") {
    try {
      return await resolveWorkItemMutation(input, kind, {
        db: this.options.db, now: this.now, stopRun: this.options.stopRun,
        latest: (id) => this.latestOrThrow(id),
        sealStopped: (stop) => this.sealPrimaryRun({ ...stop, outcome: "stopped" }),
        emit: (detail, cause, at) => this.emit(detail, cause, at),
      });
    } catch (error) { return this.translate(error, input.workItemId); }
  }

  async attach(input: Parameters<WorkItemService["attach"]>[0]) { return this.binding(input, false); }
  async detach(input: Parameters<WorkItemService["detach"]>[0]) { return this.binding(input, true); }

  private async binding(input: Parameters<WorkItemService["attach"]>[0], detach: boolean) {
    try {
      const ledger = executeWorkItemCommand(this.options.db, { requestId: input.requestId,
        workItemId: input.workItemId, command: detach ? "detach" : "attach", payload: input, at: this.now() }, () => {
        const row = getWorkItem(this.options.db, input.workItemId)!;
        if (row.lifecycle_revision !== input.expectedLifecycleRevision || row.current_run_key !== input.expectedCurrentRunKey) {
          throw new WorkItemConflictError("stale work-item lifecycle", row);
        }
        return detach
          ? detachWorkItemBinding(this.options.db, input.workItemId, input.surface, input.bindingId, this.now())
          : attachWorkItemBinding(this.options.db, { workItemId: input.workItemId, surface: input.surface, bindingId: input.bindingId, at: this.now() });
      });
      const detail = this.latestOrThrow(input.workItemId);
      this.emit(detail, ledger.idempotent ? "binding_replayed" : detach ? "binding_detached" : "binding_attached", this.now());
      const binding = ledger.value ?? listWorkItemBindings(this.options.db, input.workItemId)
        .find((row) => row.surface === input.surface && row.binding_id === input.bindingId);
      if (binding) this.emitBinding(detail, bindingSnapshot(binding), this.now());
      return detail;
    } catch (error) { return this.translate(error, input.workItemId); }
  }

  async get(id: string, cursor?: string, limit?: number) { return this.detail(id, cursor, limit); }

  async list(input: Parameters<WorkItemService["list"]>[0]) {
    const identity = resolveWorkItemProjectIdentity(input.projectId);
    if (identity && identity.aliases.length > 0) {
      const placeholders = identity.aliases.map(() => "?").join(", ");
      this.options.db.transaction(() => {
        this.options.db.prepare(`UPDATE work_items SET project_id = ?
          WHERE project_path = ? AND project_id IN (${placeholders})`)
          .run(identity.projectId, identity.projectPath, ...identity.aliases);
        this.options.db.prepare(`UPDATE sessions SET project_id = ?
          WHERE project_id IN (${placeholders})`)
          .run(identity.projectId, ...identity.aliases);
        const hasLineages = this.options.db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worktree_lineages'",
        ).get();
        if (hasLineages) {
          this.options.db.prepare(`UPDATE worktree_lineages SET project_id = ?
            WHERE repository_path = ? AND project_id IN (${placeholders})`)
            .run(identity.projectId, identity.projectPath, ...identity.aliases);
        }
      }).immediate();
    }
    const page = listWorkItemsPage(this.options.db, { ...input, limit: Math.max(1, Math.min(input.limit ?? 50, 100)) });
    return workItemListSnapshotSchema.parse({ projectId: input.projectId, items: page.rows.map(itemSnapshot), nextCursor: page.nextCursor });
  }

  async getRuns(input: Parameters<WorkItemService["getRuns"]>[0]) {
    if (!getWorkItem(this.options.db, input.workItemId)) throw new WorkItemServiceError("not_found", "work item not found", null);
    const page = listWorkItemRunsPage(this.options.db, { ...input, limit: Math.max(1, Math.min(input.limit ?? 50, 100)) });
    return workItemRunListSnapshotSchema.parse({ workItemId: input.workItemId, runs: page.rows.map(runSnapshot), nextCursor: page.nextCursor });
  }

  markWaiting(input: { workItemId: string; runKey: string; waitKind: WorkItemWaitKind; expectedLifecycleRevision: number; expectedCurrentRunKey: string; at?: number; }) {
    const at = input.at ?? this.now(); waitWorkItemRun(this.options.db, { ...input, at });
    const detail = this.latestOrThrow(input.workItemId); this.emit(detail, "run_waiting", at); return detail;
  }

  sealPrimaryRun(input: { workItemId: string; runKey: string; outcome: Exclude<Outcome, "none">; finalReportEventId?: string | null; finalReport?: string | null; expectedLifecycleRevision: number; expectedCurrentRunKey: string; at?: number; }) {
    const at = input.at ?? this.now(); sealWorkItemRun(this.options.db, { ...input, at });
    const detail = this.latestOrThrow(input.workItemId);
    this.emit(detail, "run_sealed", at); this.emitRun("work_item_run_sealed", detail, detail.currentRun!, at);
    return detail;
  }

  async startChildRun(input: { workItemId: string; parentRunKey: string; taskId: string; prompt: string; requestId: string;
    systemPrompt?: string; model?: string; thinkingConfig?: ThinkingConfig; harness?: string;
    permissionMode?: string; executorClass?: "mechanical" | "standard" | "reasoning"; skillIds?: string[]; }) {
    const runKey = this.options.generateKey("run", input.requestId);
    const ledger = executeWorkItemCommand(this.options.db, { requestId: input.requestId,
      workItemId: input.workItemId, command: "start_child_run", payload: input, at: this.now() }, () =>
      createChildWorkItemRun(this.options.db, { ...input, runKey,
        idempotencyKey: input.requestId, at: this.now() }));
    const created = ledger.value ?? { run: getRunByStartRequest(this.options.db,
      input.workItemId, input.requestId)!, idempotent: true };
    if (!created.idempotent) {
      const detail = this.latestOrThrow(input.workItemId);
      this.emit(detail, "child_run_started", this.now());
      this.emitRun("work_item_run_created", detail, runSnapshot(created.run), this.now());
    } else {
      const detail = this.latestOrThrow(input.workItemId);
      this.emit(detail, "child_run_replayed", this.now());
      this.emitRun(created.run.ended_at === null ? "work_item_run_created" : "work_item_run_sealed",
        detail, runSnapshot(created.run), this.now());
    }
    if (created.run.ended_at === null) {
      try {
        await (this.options.ensureRunLaunched ?? this.options.launchRun)({ workItemId: input.workItemId, runKey: created.run.session_key,
          parentRunKey: input.parentRunKey, taskId: input.taskId,
          prompt: input.prompt, invocationKind: "new_run", systemPrompt: input.systemPrompt,
          model: input.model, thinkingConfig: input.thinkingConfig, harness: input.harness,
          permissionMode: input.permissionMode, executorClass: input.executorClass, skillIds: input.skillIds });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.options.isRunLive?.(created.run.session_key)) {
          throw new WorkItemServiceError("internal", `Child launch acknowledgement failed for live run: ${message}`,
            this.latestOrThrow(input.workItemId));
        }
        sealChildWorkItemRun(this.options.db, { workItemId: input.workItemId,
          runKey: created.run.session_key, outcome: "error", finalReport: message, at: this.now() });
        const failed = this.latestOrThrow(input.workItemId);
        this.emit(failed, "child_run_launch_failed", this.now());
        this.emitRun("work_item_run_sealed", failed,
          runSnapshot(getWorkItemRun(this.options.db, created.run.session_key)!), this.now());
        throw new WorkItemServiceError("internal", `Child run launch failed: ${message}`,
          this.latestOrThrow(input.workItemId));
      }
    }
    return runSnapshot(created.run);
  }

  sealChildRun(input: { workItemId: string; runKey: string; outcome: Exclude<Outcome, "none">; finalReportEventId?: string | null; finalReport?: string | null; at?: number; }) {
    const at = input.at ?? this.now(); const run = runSnapshot(sealChildWorkItemRun(this.options.db, { ...input, at }).run);
    const detail = this.latestOrThrow(input.workItemId);
    this.emit(detail, "child_run_sealed", at); this.emitRun("work_item_run_sealed", detail, run, at);
    return run;
  }

  updateProviderSessionId(runKey: string, providerSessionId: string, providerGeneration = 1, at?: number): boolean {
    return updateRunProviderSessionId(this.options.db, runKey, providerSessionId, providerGeneration, at ?? this.now());
  }
}

export const createSqliteWorkItemService = (options: SqliteWorkItemServiceOptions): SqliteWorkItemService => new SqliteWorkItemService(options);
