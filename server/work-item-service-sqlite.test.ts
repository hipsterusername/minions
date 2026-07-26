import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createBus } from "./bus.ts";
import { createSqliteWorkItemService, type WorkItemInvocation } from "./work-item-service-sqlite.ts";
import { WorkItemServiceError } from "./work-item-service.ts";
import { startWorkItemIteration } from "./work-item-repo.ts";
import { createChildWorkItemRun } from "./work-item-child-repo.ts";
import type { RunContinuationInput } from "./work-item-continuation.ts";

describe("SqliteWorkItemService", () => {
  let db: Database.Database;
  let events: Array<Record<string, unknown>>;
  let launches: WorkItemInvocation[];
  let continuations: WorkItemInvocation[];
  let tick: number;
  let service: ReturnType<typeof createSqliteWorkItemService>;

  beforeEach(() => {
    db = initDb(":memory:");
    ensureWorkItemSchema(db);
    events = [];
    launches = [];
    continuations = [];
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
      now: () => tick++,
    });
  });

  async function draft(requestId = "create") {
    return service.create({
      requestId, projectId: "project-1", projectPath: "/repo",
      title: `Task ${requestId}`, changeMode: "live",
    });
  }

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
    expect(started.workItem).toMatchObject({ workflowRevision: 0,
      card: { worktreeIsolation: false } });
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

  it("durably replays create independent of a random key generator and hashes workflow input", async () => {
    let keys = 0;
    service = createSqliteWorkItemService({ db, bus: createBus({ clients: new Set() } as never),
      generateKey: (kind) => `${kind}-${++keys}`, launchRun: vi.fn(), continueRun: vi.fn(), now: () => tick++ });
    const input = { requestId: "create-random", projectId: "project-1", projectPath: "/repo",
      title: "Task", changeMode: "live" as const, workflowColumnId: "todo", workflowRank: "a" };
    const first = await service.create(input);
    expect((await service.create(input)).workItem.id).toBe(first.workItem.id);
    await expect(service.create({ ...input, workflowRank: "b" }))
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
      prompt: "Choose A", expectedLifecycleRevision: waiting.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start",
    });

    expect(resumed.workItem).toMatchObject({ waitKind: null, currentRunKey: "run-start" });
    expect(continuations).toEqual([expect.objectContaining({
      runKey: "run-start", resumeId: "provider-1", invocationKind: "resume_open_run",
    })]);
    service.sealPrimaryRun({ workItemId: created.workItem.id, runKey: "run-start",
      outcome: "error", expectedLifecycleRevision: resumed.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-start" });
    await service.replyToWaitingRun({
      requestId: "reply", workItemId: created.workItem.id, runKey: "run-start",
      prompt: "Choose A", expectedLifecycleRevision: waiting.workItem.lifecycle.lifecycleRevision,
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
      expectedLifecycleRevision: started.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: "run-live-start" };
    await service.continue(intent);
    await service.continue(intent);
    expect(queued).toHaveLength(1);
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

  it("moves cards without changing canonical lifecycle state", async () => {
    const created = await draft();
    const lifecycle = created.workItem.lifecycle;
    const moved = await service.moveCard({ requestId: "move-card",
      workItemId: created.workItem.id, expectedWorkflowRevision: 0,
      columnId: "history", targetIndex: 0 });
    expect(moved.workItem.lifecycle).toEqual(lifecycle);
    expect(moved.workItem).toMatchObject({ workflowColumnId: "history",
      workflowRank: "00000000", workflowRevision: 1 });
    expect(events.at(-2)).toMatchObject({ type: "work_item_changed", cause: "card_moved" });
  });

  it("transactionally re-ranks a column across repeated indexed moves", async () => {
    const a = await draft("rank-a"); const b = await draft("rank-b"); const c = await draft("rank-c");
    await service.moveCard({ requestId: "move-b", workItemId: b.workItem.id,
      expectedWorkflowRevision: 0, columnId: "backlog", targetIndex: 0 });
    const cAfterShift = (await service.get(c.workItem.id))!.workItem;
    await service.moveCard({ requestId: "move-c", workItemId: c.workItem.id,
      expectedWorkflowRevision: cAfterShift.workflowRevision, columnId: "backlog", targetIndex: 0 });
    const bAfterShift = (await service.get(b.workItem.id))!.workItem;
    await service.moveCard({ requestId: "move-b-again", workItemId: b.workItem.id,
      expectedWorkflowRevision: bAfterShift.workflowRevision,
      columnId: "backlog", targetIndex: 0 });
    const ordered = db.prepare(`SELECT id, workflow_rank FROM work_items
      WHERE project_id = 'project-1' ORDER BY workflow_rank, id`).all();
    expect(ordered).toEqual([
      { id: b.workItem.id, workflow_rank: "00000000" },
      { id: c.workItem.id, workflow_rank: "00000001" },
      { id: a.workItem.id, workflow_rank: "00000002" },
    ]);
  });

  it("persists full card metadata on canonical creation", async () => {
    const created = await service.create({ requestId: "create-card", projectId: "project-1",
      projectPath: "/repo", title: "Configured", changeMode: "worktree",
      workflowColumnId: "backlog", workflowRank: "1", card: { description: "Details",
        subtasks: [], context: "Context", priority: "critical", model: "gpt-5",
        harness: "codex", permissionMode: "auto", worktreeIsolation: true,
        skillIds: ["review"], skillValues: {}, linkedContextNodeIds: ["node"] } });
    expect(created.workItem).toMatchObject({ workflowRank: "1",
      lifecycle: { changeMode: "worktree" }, card: { description: "Details",
        harness: "codex", worktreeIsolation: true, linkedContextNodeIds: ["node"] } });
  });

  it("preserves durable card metadata when a canvas binding is removed", async () => {
    const created = await draft();
    const updated = await service.updateCard({ requestId: "card-details",
      workItemId: created.workItem.id, expectedWorkflowRevision: 0,
      title: "Durable card", patch: { description: "Keep me", leaderNodeId: "node-1",
        subtasks: [{ id: "sub-1", title: "Test", done: true }] } });
    const attached = await service.attach({ requestId: "attach-card", workItemId: created.workItem.id,
      surface: "canvas", bindingId: "node-1",
      expectedLifecycleRevision: updated.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: null });
    await service.detach({ requestId: "detach-card", workItemId: created.workItem.id,
      surface: "canvas", bindingId: "node-1",
      expectedLifecycleRevision: attached.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: null });
    const detail = await service.get(created.workItem.id);
    expect(detail?.workItem).toMatchObject({ title: "Durable card",
      card: { description: "Keep me", leaderNodeId: null,
        subtasks: [{ id: "sub-1", done: true }] } });
    expect(detail?.workItem.lifecycle).toEqual(created.workItem.lifecycle);
    expect(detail?.workItem.workflowRevision).toBe(2);
    expect(detail?.bindings[0]).toMatchObject({ bindingId: "node-1", detachedAt: expect.any(Number) });
  });

  it("imports a local board once with stable IDs without duplicating run history", async () => {
    const card = { id: "legacy-history", title: "Finished before migration",
      columnId: "history", rank: "0001", createdAt: 5,
      description: "Original", subtasks: [{ id: "s", title: "Done", done: true }],
      context: "context", priority: "high" as const, model: "gpt-5", harness: "codex",
      permissionMode: "auto", worktreeIsolation: true, skillIds: ["review"],
      skillValues: { review: { depth: "high" } }, linkedContextNodeIds: ["context-1"],
      agentSummary: "Shipped", archivedMessages: [{ role: "assistant", content: "done" }],
      archivedTaskPlan: [{ id: "task", status: "completed" }], archivedTurns: 3,
      autoSynced: true };
    const input = { requestId: "00000000-0000-4000-8000-000000000090",
      projectId: "project-1", projectPath: "/repo", migrationKey: "local-storage-v1",
      cards: [card, card] };
    const first = await service.importKanban(input);
    const replay = await service.importKanban(input);
    expect(first.items).toHaveLength(1);
    expect(replay.items).toHaveLength(1);
    expect(replay.items[0]?.id).toBe(first.items[0]?.id);
    const remappedReplay = await service.importKanban({ ...input,
      cards: input.cards.map((entry) => ({ ...entry, existingWorkItemId: "later-canvas-choice" })) });
    expect(remappedReplay.items).toHaveLength(1);
    expect(remappedReplay.items[0]?.id).toBe(first.items[0]?.id);
    expect(first.items[0]).toMatchObject({ workflowColumnId: "history",
      lifecycle: { runtimeState: "draft", outcome: "none", resolution: "open" },
      card: { legacyCardId: "legacy-history", agentSummary: "Shipped", autoSynced: true } });
    expect(first.items[0]?.card).not.toHaveProperty("archivedMessages");
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE project_id = 'project-1'").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_item_import_entries").get())
      .toEqual({ count: 1 });
    await expect(service.importKanban({ ...input, cards: [{ ...card, title: "Changed" }] }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("reconciles an imported legacy card onto an existing canvas work item", async () => {
    const existing = await draft("existing-canvas");
    const imported = await service.importKanban({
      requestId: "00000000-0000-4000-8000-000000000091", projectId: "project-1",
      projectPath: "/repo", migrationKey: "canvas-reconcile-v1", cards: [{
        id: "legacy-card", existingWorkItemId: existing.workItem.id,
        title: "Canvas-backed card", columnId: "in-progress", rank: "00000000", createdAt: 1,
        description: "Preserved", subtasks: [], context: "", priority: "medium",
        model: "", permissionMode: "auto", worktreeIsolation: false,
        skillIds: [], skillValues: {}, linkedContextNodeIds: [], leaderNodeId: "node-1",
      }],
    });
    expect(imported.items).toHaveLength(1);
    expect(imported.items[0]).toMatchObject({ id: existing.workItem.id,
      workflowColumnId: "in-progress", card: { legacyCardId: "legacy-card",
        leaderNodeId: "node-1", description: "Preserved" } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE project_id = 'project-1'").get())
      .toEqual({ count: 1 });
  });
});
