import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createBus } from "./bus.ts";
import { createSqliteWorkItemService, type WorkItemInvocation } from "./work-item-service-sqlite.ts";
import { WorkItemServiceError } from "./work-item-service.ts";
import { startWorkItemIteration } from "./work-item-repo.ts";
import { createChildWorkItemRun } from "./work-item-child-repo.ts";
import type { RunContinuationInput } from "./work-item-continuation.ts";
import { encodePath } from "./routes/projects/helpers.ts";
import { registerWorkspace } from "./workspace-registry.ts";
import { ensureWorktreeIntegrationSchema } from "./worktree-integration-schema.ts";

describe("SqliteWorkItemService", () => {
  let db: Database.Database;
  let events: Array<Record<string, unknown>>;
  let launches: WorkItemInvocation[];
  let continuations: WorkItemInvocation[];
  let stoppedRuns: Array<{ workItemId: string; runKey: string }>;
  let tick: number;
  let service: ReturnType<typeof createSqliteWorkItemService>;

  beforeEach(() => {
    db = initDb(":memory:");
    ensureWorkItemSchema(db);
    events = [];
    launches = [];
    continuations = [];
    stoppedRuns = [];
    tick = 10;
    const bus = createBus({ clients: new Set() } as never);
    bus.subscribe((event) => events.push(event as Record<string, unknown>));
    service = createSqliteWorkItemService({
      db,
      bus,
      generateKey: (kind, requestId) => `${kind}-${requestId}`,
      launchRun: async (input) => {
        expect((db.prepare("SELECT work_item_id FROM sessions WHERE session_key = ?").get(input.runKey) as { work_item_id: string }).work_item_id)
          .toBe(input.workItemId);
        launches.push(input);
      },
      continueRun: async (input) => { continuations.push(input); },
      stopRun: async (input) => { stoppedRuns.push(input); },
      now: () => tick++,
    });
  });

  async function draft(requestId = "create") {
    return service.create({
      requestId, projectId: "project-1", projectPath: "/repo",
      title: `Task ${requestId}`, changeMode: "live",
    });
  }

  it("lazily migrates encoded project identities when listing by workspace UUID", async () => {
    const minionsHome = fs.mkdtempSync(path.join(os.tmpdir(), "work-item-alias-home-"));
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "work-item-alias-source-"));
    vi.stubEnv("MINIONS_HOME", minionsHome);
    try {
      const workspace = registerWorkspace(projectPath)!;
      const legacy = await service.create({
        requestId: "legacy-create",
        projectId: encodePath(workspace.sourceRoot),
        projectPath: workspace.sourceRoot,
        title: "Existing item",
        changeMode: "live",
      });
      ensureWorktreeIntegrationSchema(db);
      db.prepare(`INSERT INTO worktree_lineages (
        id, project_id, repository_path, target_ref, base_sha,
        integration_ref, integration_worktree_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "legacy-lineage", encodePath(workspace.sourceRoot), workspace.sourceRoot,
        "main", "base", "refs/heads/legacy", "/tmp/legacy-integration", 1, 1,
      );

      const listed = await service.list({ projectId: workspace.id, includeArchived: true });
      expect(listed.items).toEqual([expect.objectContaining({
        id: legacy.workItem.id,
        projectId: workspace.id,
      })]);
      expect((db.prepare("SELECT project_id FROM work_items WHERE id = ?")
        .get(legacy.workItem.id) as { project_id: string }).project_id).toBe(workspace.id);
      expect((db.prepare("SELECT project_id FROM worktree_lineages WHERE id = ?")
        .get("legacy-lineage") as { project_id: string }).project_id).toBe(workspace.id);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(minionsHome, { recursive: true, force: true });
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("commits a server-keyed run before launch and publishes item/project snapshots", async () => {
    const created = await draft();
    const started = await service.startRun({
      requestId: "start", workItemId: created.workItem.id, prompt: "Go",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null,
    });

    expect(started.currentRun).toMatchObject({
      runKey: "run-start", runKind: "primary", runNumber: 1,
      providerSessionId: null, finalReport: null,
    });
    expect(launches).toEqual([expect.objectContaining({
      runKey: "run-start", invocationKind: "new_run", prompt: "Go",
    })]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: `work-item:${created.workItem.id}`, type: "work_item_changed" }),
      expect.objectContaining({ topic: "project:project-1", type: "work_item_changed" }),
      expect.objectContaining({ topic: `work-item:${created.workItem.id}`, type: "work_item_run_created" }),
      expect.objectContaining({ topic: "project:project-1", type: "work_item_run_created" }),
    ]));
    expect(events.findIndex((event) => event["type"] === "work_item_changed"))
      .toBeLessThan(events.findIndex((event) => event["type"] === "work_item_run_created"));
    await expect(service.startRun({
      requestId: "start", workItemId: created.workItem.id, prompt: "Changed prompt",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null,
    })).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("stops an active run before archiving and ignores the pre-stop lifecycle fence", async () => {
    const created = await draft();
    const started = await service.startRun({
      requestId: "active-start",
      workItemId: created.workItem.id,
      prompt: "Keep working",
      expectedLifecycleRevision: created.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: null,
    });

    const archived = await service.archive({
      requestId: "dismiss-active",
      workItemId: created.workItem.id,
      expectedLifecycleRevision: started.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: started.workItem.currentRunKey,
    });

    expect(stoppedRuns).toEqual([{
      workItemId: created.workItem.id,
      runKey: "run-active-start",
    }]);
    expect(archived.workItem.lifecycle).toMatchObject({
      runtimeState: "inactive",
      outcome: "stopped",
      resolution: "archived",
    });
    expect(archived.currentRun).toMatchObject({
      runKey: "run-active-start",
      outcome: "stopped",
      endedAt: expect.any(Number),
    });
  });

  it("inherits primary settings and only resumes a provider on the same harness", async () => {
    const created = await draft();
    let current = await service.startRun({ requestId: "configured", workItemId: created.workItem.id,
      prompt: "first", expectedLifecycleRevision: 0, expectedCurrentRunKey: null,
      harness: "codex", model: "gpt-5", permissionMode: "auto",
      thinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      skillIds: ["review"], skillValues: { review: { depth: "high" } } });
    service.updateProviderSessionId("run-configured", "provider-first");
    current = service.sealPrimaryRun({ workItemId: created.workItem.id, runKey: "run-configured",
      outcome: "error", expectedLifecycleRevision: current.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-configured" });
    current = await service.startRun({ requestId: "inherited", workItemId: created.workItem.id,
      prompt: "second", expectedLifecycleRevision: current.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-configured" });
    expect(launches.at(-1)).toMatchObject({ harness: "codex", model: "gpt-5",
      permissionMode: "auto", skillIds: ["review"],
      skillValues: { review: { depth: "high" } }, resumeId: "provider-first" });

    service.updateProviderSessionId("run-inherited", "provider-second");
    current = service.sealPrimaryRun({ workItemId: created.workItem.id, runKey: "run-inherited",
      outcome: "error", expectedLifecycleRevision: current.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-inherited" });
    await service.startRun({ requestId: "different-harness", workItemId: created.workItem.id,
      prompt: "third", expectedLifecycleRevision: current.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-inherited", harness: "claude" });
    expect(launches.at(-1)).toMatchObject({ harness: "claude", model: "gpt-5" });
    expect(launches.at(-1)).not.toHaveProperty("resumeId");
  });

  it("preserves canonical live mode for every harness", async () => {
    const codex = await draft("codex-live");
    const started = await service.startRun({ requestId: "codex-live-start",
      workItemId: codex.workItem.id, prompt: "change files", harness: "codex",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    expect(started.workItem.lifecycle).toMatchObject({ changeMode: "live",
      integrationState: "live_clean" });
    expect(launches.at(-1)).toMatchObject({ harness: "codex" });

    const claude = await draft("claude-live");
    const live = await service.startRun({ requestId: "claude-live-start",
      workItemId: claude.workItem.id, prompt: "change files", harness: "claude",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    expect(live.workItem.lifecycle).toMatchObject({ changeMode: "live",
      integrationState: "live_clean" });

    const echo = await draft("echo-live");
    const uncoordinated = await service.startRun({ requestId: "echo-live-start",
      workItemId: echo.workItem.id, prompt: "no interception", harness: "echo",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    expect(uncoordinated.workItem.lifecycle).toMatchObject({ changeMode: "live",
      integrationState: "live_clean" });
  });

  it("durably replays create independent of a random key generator and hashes input", async () => {
    let keys = 0;
    service = createSqliteWorkItemService({ db, bus: createBus({ clients: new Set() } as never),
      generateKey: (kind) => `${kind}-${++keys}`, launchRun: vi.fn(), continueRun: vi.fn(), now: () => tick++ });
    const input = { requestId: "create-random", projectId: "project-1", projectPath: "/repo",
      title: "Task", changeMode: "live" as const };
    const first = await service.create(input);
    expect((await service.create(input)).workItem.id).toBe(first.workItem.id);
    await expect(service.create({ ...input, title: "Changed" }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toEqual({ n: 1 });
  });

  it("ensures primary and child launches after a crash between commit and callback", async () => {
    const created = await draft();
    startWorkItemIteration(db, { workItemId: created.workItem.id, runKey: "run-primary",
      idempotencyKey: "primary", expectedLifecycleRevision: 0,
      expectedCurrentRunKey: null, at: tick++ });
    const ensured: string[] = [];
    service = createSqliteWorkItemService({ db, bus: createBus({ clients: new Set() } as never),
      generateKey: (_kind, requestId) => `run-${requestId}`,
      launchRun: () => { throw new Error("must use ensure"); },
      ensureRunLaunched: (input) => { ensured.push(input.runKey); },
      continueRun: vi.fn(), now: () => tick++ });
    await service.startRun({ requestId: "primary", workItemId: created.workItem.id,
      prompt: "resume launch", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });

    createChildWorkItemRun(db, { workItemId: created.workItem.id, runKey: "run-child",
      parentRunKey: "run-primary", taskId: "task", idempotencyKey: "child", at: tick++ });
    await service.startChildRun({ requestId: "child", workItemId: created.workItem.id,
      parentRunKey: "run-primary", taskId: "task", prompt: "child" });
    expect(ensured).toEqual(["run-primary", "run-child"]);
  });

  it("seals a committed run error when post-commit launch fails", async () => {
    const created = await draft();
    service = createSqliteWorkItemService({
      db,
      bus: createBus({ clients: new Set() } as never),
      generateKey: (kind, requestId) => `${kind}-${requestId}`,
      launchRun: () => { throw new Error("runtime unavailable"); },
      continueRun: vi.fn(),
      now: () => tick++,
    });

    await expect(service.startRun({
      requestId: "failed", workItemId: created.workItem.id, prompt: "Go",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null,
    })).rejects.toMatchObject({
      code: "internal",
      latest: { workItem: { lifecycle: { outcome: "error" } } },
    });
    expect(db.prepare("SELECT run_outcome, ended_at FROM sessions WHERE session_key = 'run-failed'").get())
      .toMatchObject({ run_outcome: "error", ended_at: expect.any(Number) });
  });

  it("resumes a structured wait on the same run and provider session", async () => {
    const created = await draft();
    const started = await service.startRun({
      requestId: "start", workItemId: created.workItem.id, prompt: "Go",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null,
    });
    service.updateProviderSessionId("run-start", "provider-1");
    db.prepare(`UPDATE work_items SET runtime_state = 'working' WHERE id = ?`).run(created.workItem.id);
    const waiting = service.markWaiting({
      workItemId: created.workItem.id, runKey: "run-start", waitKind: "decision",
      expectedLifecycleRevision: started.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start",
    });
    expect(waiting.workItem.waitKind).toBe("decision");

    const resumed = await service.replyToWaitingRun({
      requestId: "reply", workItemId: created.workItem.id, runKey: "run-start",
      prompt: "Choose A", skillIds: ["review"],
      skillValues: { review: { depth: "high" } },
      expectedLifecycleRevision: waiting.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start",
    });

    expect(resumed.workItem).toMatchObject({ waitKind: null, currentRunKey: "run-start" });
    expect(continuations).toEqual([expect.objectContaining({
      runKey: "run-start", resumeId: "provider-1", invocationKind: "resume_open_run",
      skillIds: ["review"], skillValues: { review: { depth: "high" } },
    })]);
    service.sealPrimaryRun({ workItemId: created.workItem.id, runKey: "run-start",
      outcome: "error", expectedLifecycleRevision: resumed.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start" });
    await service.replyToWaitingRun({
      requestId: "reply", workItemId: created.workItem.id, runKey: "run-start",
      prompt: "Choose A", skillIds: ["review"],
      skillValues: { review: { depth: "high" } },
      expectedLifecycleRevision: waiting.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start",
    });
    expect(continuations).toHaveLength(1);
  });

  it("routes one continuation intent through waits, active guidance, and orphan recovery", async () => {
    const created = await draft("intent");
    let current = await service.startRun({ requestId: "intent-start",
      workItemId: created.workItem.id, prompt: "start",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    db.prepare(`UPDATE work_items SET runtime_state = 'working' WHERE id = ?`)
      .run(created.workItem.id);
    current = service.markWaiting({ workItemId: created.workItem.id,
      runKey: "run-intent-start", waitKind: "file_conflict",
      expectedLifecycleRevision: current.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-intent-start" });
    const resumed = await service.continue({ requestId: "intent-wait",
      workItemId: created.workItem.id, prompt: "files are resolved",
      expectedLifecycleRevision: current.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-intent-start" });
    expect(resumed.workItem.currentRunKey).toBe("run-intent-start");
    expect(continuations.at(-1)).toMatchObject({ prompt: "files are resolved",
      runKey: "run-intent-start" });

    const orphaned = await service.continue({ requestId: "intent-orphan",
      workItemId: created.workItem.id, prompt: "recover and continue",
      expectedLifecycleRevision: resumed.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-intent-start" });
    expect(orphaned.workItem).toMatchObject({ currentRunKey: "run-intent-orphan",
      iteration: 2 });
    expect(db.prepare(`SELECT run_outcome FROM sessions
      WHERE session_key = 'run-intent-start'`).get()).toEqual({
      run_outcome: "interrupted",
    });
  });

  it("queues live guidance once and returns structured stale conflicts", async () => {
    const queued: RunContinuationInput[] = [];
    service = createSqliteWorkItemService({
      db, bus: createBus({ clients: new Set() } as never),
      generateKey: (kind, requestId) => `${kind}-${requestId}`,
      launchRun: async (input) => { launches.push(input); },
      continueRun: async (input) => { continuations.push(input); },
      isRunLive: () => true,
      queueRunGuidance: async (input) => { queued.push(input); },
      now: () => tick++,
    });
    const created = await draft("live-intent");
    const started = await service.startRun({ requestId: "live-start",
      workItemId: created.workItem.id, prompt: "start",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    const intent = { requestId: "live-guidance", workItemId: created.workItem.id,
      prompt: "steer this turn",
      skillIds: ["review"], skillValues: { review: { depth: "high" } },
      expectedLifecycleRevision: started.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-live-start" };
    await service.continue(intent);
    await service.continue(intent);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ skillIds: ["review"],
      skillValues: { review: { depth: "high" } } });
    await expect(service.continue({ ...intent, requestId: "stale",
      expectedLifecycleRevision: 0 })).rejects.toMatchObject({
      code: "conflict", latest: { workItem: { currentRunKey: "run-live-start" } },
    });
  });

  it("resumes primary runs through the ledger and atomically clears legacy decisions", async () => {
    const created = await draft();
    const started = await service.startRun({ requestId: "start-primary", workItemId: created.workItem.id,
      prompt: "Go", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    db.prepare(`UPDATE work_items SET runtime_state = 'working' WHERE id = ?`)
      .run(created.workItem.id);
    db.prepare(`UPDATE sessions SET review_state = 'completion_to_review', review_reason = 'old',
      acknowledged_at = 1, dismissed_at = 2 WHERE session_key = 'run-start-primary'`).run();
    const waiting = service.markWaiting({ workItemId: created.workItem.id,
      runKey: "run-start-primary", waitKind: "decision",
      expectedLifecycleRevision: started.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start-primary" });
    await service.resumePrimaryRun({ requestId: "resume-primary", workItemId: created.workItem.id,
      runKey: "run-start-primary", prompt: "continue" });
    expect(db.prepare(`SELECT review_state, review_reason, acknowledged_at, dismissed_at
      FROM sessions WHERE session_key = 'run-start-primary'`).get()).toEqual({
      review_state: "none", review_reason: null, acknowledged_at: null, dismissed_at: null });
    await service.resumePrimaryRun({ requestId: "resume-primary", workItemId: created.workItem.id,
      runKey: "run-start-primary", prompt: "continue" });
    expect(continuations).toHaveLength(2);
    await expect(service.resumePrimaryRun({ requestId: "resume-primary",
      workItemId: created.workItem.id, runKey: "run-start-primary", prompt: "changed" }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(waiting.workItem.waitKind).toBe("decision");
  });

  it("ledgers child continuations and safely re-ensures exact retries", async () => {
    const created = await draft();
    await service.startRun({ requestId: "parent", workItemId: created.workItem.id,
      prompt: "Go", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    await service.startChildRun({ requestId: "child", workItemId: created.workItem.id,
      parentRunKey: "run-parent", taskId: "task", prompt: "child" });
    service.updateProviderSessionId("run-child", "provider-child");
    continuations = [];
    const input = { requestId: "continue-child", workItemId: created.workItem.id,
      runKey: "run-child", prompt: "continue" };
    await service.continueChildRun(input);
    await service.continueChildRun(input);
    expect(continuations).toEqual([
      expect.objectContaining({ resumeId: "provider-child", invocationKind: "resume_open_run" }),
      expect.objectContaining({ resumeId: "provider-child", invocationKind: "resume_open_run" }),
    ]);
    await expect(service.continueChildRun({ ...input, prompt: "changed" }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("maps durable provider/report fields and binding history into snapshots", async () => {
    const created = await draft();
    const started = await service.startRun({
      requestId: "start", workItemId: created.workItem.id, prompt: "Go",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null,
    });
    service.updateProviderSessionId("run-start", "provider-1");
    const sealed = service.sealPrimaryRun({
      workItemId: created.workItem.id, runKey: "run-start", outcome: "completed",
      finalReportEventId: "report-event", finalReport: "Implemented and tested",
      expectedLifecycleRevision: started.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start",
    });
    const attached = await service.attach({
      requestId: "attach", workItemId: created.workItem.id, surface: "canvas",
      bindingId: "node-1", expectedLifecycleRevision: sealed.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start",
    });
    const detached = await service.detach({
      requestId: "detach", workItemId: created.workItem.id, surface: "canvas",
      bindingId: "node-1", expectedLifecycleRevision: attached.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start",
    });

    expect(detached.currentRun).toMatchObject({
      providerSessionId: "provider-1",
      finalReport: "Implemented and tested",
      outcome: "completed",
    });
    expect(detached.bindings).toEqual([
      expect.objectContaining({ bindingId: "node-1", detachedAt: expect.any(Number) }),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: `work-item:${created.workItem.id}`, type: "work_item_run_sealed" }),
      expect.objectContaining({ topic: "project:project-1", type: "work_item_run_sealed" }),
      expect.objectContaining({ topic: `work-item:${created.workItem.id}`, type: "work_item_binding_changed" }),
      expect.objectContaining({ topic: "project:project-1", type: "work_item_binding_changed" }),
    ]));
  });

  it("publishes a late-report upgrade from interrupted to completed", async () => {
    const created = await draft();
    const started = await service.startRun({
      requestId: "late-start", workItemId: created.workItem.id, prompt: "Go",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null,
    });
    const interrupted = service.sealPrimaryRun({
      workItemId: created.workItem.id, runKey: "run-late-start",
      outcome: "interrupted",
      expectedLifecycleRevision: started.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-late-start",
    });
    events = [];

    const upgraded = service.sealPrimaryRun({
      workItemId: created.workItem.id, runKey: "run-late-start",
      outcome: "completed",
      finalReportEventId: "late-report", finalReport: "Completed later",
      expectedLifecycleRevision: interrupted.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-late-start",
    });

    expect(upgraded).toMatchObject({
      workItem: { lifecycle: { runtimeState: "inactive", outcome: "completed" } },
      currentRun: { outcome: "completed", finalReport: "Completed later" },
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        topic: `work-item:${created.workItem.id}`,
        type: "work_item_run_sealed",
      }),
      expect.objectContaining({
        topic: "project:project-1",
        type: "work_item_run_sealed",
      }),
    ]));
  });

  it("paginates items and preserves archived resolution through restore", async () => {
    const first = await draft("a");
    await draft("b");
    const page1 = await service.list({ projectId: "project-1", limit: 1 });
    const page2 = await service.list({ projectId: "project-1", limit: 1, cursor: page1.nextCursor! });
    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);

    await service.startRun({ requestId: "start-a", workItemId: first.workItem.id,
      prompt: "Go", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    const sealed = service.sealPrimaryRun({ workItemId: first.workItem.id, runKey: "run-start-a",
      outcome: "error", expectedLifecycleRevision: 1, expectedCurrentRunKey: "run-start-a" });
    const reviewed = await service.review({ requestId: "review", workItemId: first.workItem.id,
      expectedLifecycleRevision: sealed.workItem.lifecycle.lifecycleRevision, expectedCurrentRunKey: "run-start-a" });
    const archived = await service.archive({ requestId: "archive", workItemId: first.workItem.id,
      expectedLifecycleRevision: reviewed.workItem.lifecycle.lifecycleRevision, expectedCurrentRunKey: "run-start-a" });
    const restored = await service.restore({ requestId: "restore", workItemId: first.workItem.id,
      expectedLifecycleRevision: archived.workItem.lifecycle.lifecycleRevision, expectedCurrentRunKey: "run-start-a" });
    expect(restored.workItem.lifecycle.resolution).toBe("reviewed");
    expect(events.filter((event) => event["type"] === "work_item_changed")
      .map((event) => event["cause"])).toEqual(expect.arrayContaining([
        "review", "archive", "restore",
      ]));
  });

  it("returns typed conflicts with the latest valid snapshot", async () => {
    const created = await draft();
    await expect(service.startRun({ requestId: "stale", workItemId: created.workItem.id,
      prompt: "Go", expectedLifecycleRevision: 99, expectedCurrentRunKey: null }))
      .rejects.toBeInstanceOf(WorkItemServiceError);
    await expect(service.startRun({ requestId: "stale-2", workItemId: created.workItem.id,
      prompt: "Go", expectedLifecycleRevision: 99, expectedCurrentRunKey: null }))
      .rejects.toMatchObject({ code: "conflict", latest: { workItem: { id: created.workItem.id } } });
  });

  it("ledgers mutations atomically and rejects changed-input request reuse", async () => {
    const created = await draft();
    const started = await service.startRun({ requestId: "start", workItemId: created.workItem.id,
      prompt: "Go", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    const sealed = service.sealPrimaryRun({ workItemId: created.workItem.id, runKey: "run-start",
      outcome: "error", expectedLifecycleRevision: 1, expectedCurrentRunKey: "run-start" });
    const request = { requestId: "review-once", workItemId: created.workItem.id,
      expectedLifecycleRevision: sealed.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start" };
    const reviewed = await service.review(request);
    expect((await service.review(request)).workItem.lifecycle.lifecycleRevision)
      .toBe(reviewed.workItem.lifecycle.lifecycleRevision);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "work_item_changed", cause: "review_replayed" }),
    ]));
    await expect(service.review({ ...request, expectedLifecycleRevision: 999 }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });

    await expect(service.attach({ requestId: "stale-binding", workItemId: created.workItem.id,
      surface: "canvas", bindingId: "node", expectedLifecycleRevision: 999,
      expectedCurrentRunKey: "run-start" })).rejects.toMatchObject({ code: "conflict" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_item_commands WHERE request_id = 'stale-binding'").get())
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_item_bindings").get()).toEqual({ n: 0 });
    expect(started.currentRun?.runKey).toBe("run-start");
  });

});
