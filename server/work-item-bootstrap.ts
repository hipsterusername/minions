import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Bus } from "./bus.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type {
  StartSessionOptions,
  WorkItemRuntimeLifecycle,
} from "./session-host-types.ts";
import { launchSession } from "./session-launch.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import {
  backfillLegacyWorkItems,
  recoverOrphanedWorkItemRuns,
  repairCompletedRunsWithoutReports,
  type BootRecoveryResult,
  type LegacyBackfillResult,
} from "./work-item-migration.ts";
import { getWorkItem } from "./work-item-repo.ts";
import {
  createSqliteWorkItemService,
  type SqliteWorkItemService,
  type WorkItemInvocation,
} from "./work-item-service-sqlite.ts";
import { createWorkItemRuntimeLifecycle } from "./work-item-runtime-lifecycle.ts";
import { queueWorkItemGuidance } from "./work-item-continuation.ts";
import { randomUUID } from "node:crypto";

/** Stable across restarts and processes; request IDs are globally scoped. */
export function workItemRequestKey(
  kind: "work_item" | "run",
  requestId: string,
): string {
  const hex = createHash("sha256").update(`minions:${kind}\0${requestId}`).digest("hex").slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
  return `${kind === "work_item" ? "work" : "run"}-${uuid}`;
}

export interface WorkItemBootstrapOptions {
  db: Database.Database;
  bus: Bus;
  registry: Pick<SessionRegistry, "get">;
  launch?: (options: StartSessionOptions) => void | Promise<unknown>;
  liveRunKeys?: ReadonlySet<string>;
  now?: () => number;
  /** Hook adapter lands separately; retained here as the runtime seam. */
  runtimeLifecycle?: WorkItemRuntimeLifecycle;
  bindWorktreeRun?: (input: { workItemId: string; runKey: string }) =>
    void | import("./worktree-create.ts").PlannedWorktree |
    Promise<void | import("./worktree-create.ts").PlannedWorktree>;
  collectWorktreeRun?: (runKey: string,
    outcome: "completed" | "error" | "stopped" | "interrupted") => Promise<void>;
}

export interface WorkItemBootstrapResult {
  workItems: SqliteWorkItemService;
  backfill: LegacyBackfillResult;
  recovery: BootRecoveryResult;
  runtimeLifecycle: WorkItemRuntimeLifecycle;
  launchRun(input: WorkItemInvocation): Promise<void>;
  continueRun(input: WorkItemInvocation): Promise<void>;
  registerChildAllocationCallback(requestId: string, callback: (runKey: string) => void): () => void;
}

export function bootstrapWorkItemRuntime(
  options: WorkItemBootstrapOptions,
): WorkItemBootstrapResult {
  ensureWorkItemSchema(options.db);
  const at = (options.now ?? Date.now)();
  const backfill = backfillLegacyWorkItems(options.db, at);
  // Pre-existing rows can predate the finalReport write-path guard; repair
  // them before anything tries to read/serialize a work-item snapshot.
  const repairedCompletedRunKeys = repairCompletedRunsWithoutReports(options.db, at);
  const orphanRecovery = recoverOrphanedWorkItemRuns(
    options.db,
    options.liveRunKeys ?? new Set(),
    at,
  );
  const recovery: BootRecoveryResult = { ...orphanRecovery, repairedCompletedRunKeys };
  const launch = options.launch ?? ((sessionOptions: StartSessionOptions) =>
    launchSession({
      registry: options.registry as SessionRegistry,
      bus: options.bus,
      options: sessionOptions,
      executorClass: sessionOptions.executorClass,
    }));
  const childAllocationCallbacks = new Map<string, (runKey: string) => void>();

  const launchRun = async (input: WorkItemInvocation): Promise<void> => {
    const item = getWorkItem(options.db, input.workItemId);
    if (!item) throw new Error(`Work item ${input.workItemId} not found`);
    const child = input.parentRunKey !== undefined;
    const parent = child ? options.registry.get(input.parentRunKey!) : undefined;
    if (child && (!input.taskId || !parent)) {
      throw new Error(`Child run ${input.runKey} requires a live parent and task`);
    }
    const sessionOptions: StartSessionOptions = {
      sessionKey: input.runKey,
      invocationKind: input.invocationKind,
      workItemId: input.workItemId,
      runKind: child ? "child" : "primary",
      parentRunKey: child ? input.parentRunKey! : null,
      taskId: child ? input.taskId! : null,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      cwd: child ? parent!.cwd : item.project_path,
      role: child ? "minion" : "leader",
      worktreeIsolation: child ? false : item.change_mode === "worktree",
      ...(input.plannedContribution ? { plannedContribution: input.plannedContribution } : {}),
      ...(child && parent!.worktree ? { parentWorktree: parent!.worktree } : {}),
      ...(input.resumeId ? { resumeId: input.resumeId } : {}),
      ...(input.model ? { initialModel: input.model } : {}),
      ...(input.thinkingConfig ? { thinkingConfig: input.thinkingConfig } : {}),
      ...(input.harness ? { harness: input.harness } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.executorClass ? { executorClass: input.executorClass } : {}),
      ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      ...(input.skillValues ? { skillValues: input.skillValues } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
    };
    await launch(sessionOptions);
  };

  const continueRun = async (input: WorkItemInvocation): Promise<void> => {
    const host = options.registry.get(input.runKey);
    if (!host || host.workItemId !== input.workItemId) {
      throw new Error(`Cannot resume missing work-item run ${input.runKey}`);
    }
    await launch({
      sessionKey: host.runKey,
      invocationKind: "resume_open_run",
      workItemId: host.workItemId,
      runKind: host.runKind,
      parentRunKey: host.parentRunKey,
      taskId: host.taskId,
      prompt: input.prompt,
      cwd: host.cwd,
      role: host.role,
      worktreeIsolation: host.worktreeIsolation,
      resumeId: input.resumeId ?? host.sessionId ?? undefined,
      harness: host.harnessName,
      initialModel: host.model,
      permissionMode: host.permissionMode ?? undefined,
      thinkingConfig: host.thinkingConfig,
    });
  };

  const isRunLive = (runKey: string): boolean => {
    const host = options.registry.get(runKey);
    return Boolean(host && host.status === "running" && !host.abortController.signal.aborted);
  };
  const ensureRunLaunched = async (input: WorkItemInvocation): Promise<void> => {
    const host = options.registry.get(input.runKey);
    if (host) {
      if (host.workItemId !== input.workItemId) throw new Error(`Run ${input.runKey} identity mismatch`);
      childAllocationCallbacks.get(input.requestId ?? input.runKey)?.(input.runKey);
      return;
    }
    childAllocationCallbacks.get(input.requestId ?? input.runKey)?.(input.runKey);
    await launchRun(input);
  };
  const ensureRunContinued = async (input: WorkItemInvocation): Promise<void> => {
    if (isRunLive(input.runKey)) return;
    await continueRun(input);
  };

  let workItems!: SqliteWorkItemService;
  workItems = createSqliteWorkItemService({
    db: options.db,
    bus: options.bus,
    generateKey: workItemRequestKey,
    launchRun,
    ensureRunLaunched,
    continueRun,
    ensureRunContinued,
    isRunLive,
    queueRunGuidance: (input) => {
      const host = options.registry.get(input.runKey);
      if (!host || host.workItemId !== input.workItemId) {
        throw new Error(`Cannot queue guidance for missing work-item run ${input.runKey}`);
      }
      queueWorkItemGuidance(host, async () => {
        const latest = workItems.getSync(input.workItemId);
        if (!latest) return;
        await workItems.continue({
          requestId: `${input.requestId}:queued:${randomUUID()}`,
          workItemId: input.workItemId, prompt: input.prompt,
          expectedLifecycleRevision: latest.workItem.lifecycle.lifecycleRevision,
          expectedCurrentRunKey: latest.workItem.currentRunKey,
        });
      });
    },
    now: options.now,
    ...(options.bindWorktreeRun ? { bindWorktreeRun: options.bindWorktreeRun } : {}),
  });
  const runtimeLifecycle = options.runtimeLifecycle ?? createWorkItemRuntimeLifecycle({
    db: options.db, bus: options.bus, service: workItems,
    ...(options.collectWorktreeRun ? { collectWorktreeRun: options.collectWorktreeRun } : {}),
  });
  return {
    workItems,
    backfill,
    recovery,
    runtimeLifecycle,
    launchRun,
    continueRun,
    registerChildAllocationCallback(requestId, callback) {
      childAllocationCallbacks.set(requestId, callback);
      const runKey = workItemRequestKey("run", requestId);
      childAllocationCallbacks.set(runKey, callback);
      return () => { childAllocationCallbacks.delete(requestId); childAllocationCallbacks.delete(runKey); };
    },
  };
}
