import { describe, expect, it, vi } from "vitest";
import type { StartSessionOptions } from "./session-host-types.ts";
import { SessionHost } from "./session-host.ts";
import { initDb } from "./db.ts";
import { createBus } from "./bus.ts";
import {
  bootstrapWorkItemRuntime,
  workItemRequestKey,
} from "./work-item-bootstrap.ts";

function bus() {
  return createBus({ clients: new Set() } as never);
}

describe("work-item production bootstrap", () => {
  it("derives stable globally namespaced UUID-style keys", () => {
    expect(workItemRequestKey("work_item", "request-1"))
      .toBe(workItemRequestKey("work_item", "request-1"));
    expect(workItemRequestKey("work_item", "request-1"))
      .not.toBe(workItemRequestKey("run", "request-1"));
    expect(workItemRequestKey("run", "request-1"))
      .toMatch(/^run-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("backfills and recovers before returning the command service", () => {
    const db = initDb(":memory:");
    db.prepare(`
      INSERT INTO sessions (
        session_key, status, cwd, role, review_state, lifecycle_revision,
        created_at, updated_at
      ) VALUES ('legacy-live', 'running', '/repo', 'leader', 'none', 2, 'old', 'old')
    `).run();
    const runtime = bootstrapWorkItemRuntime({
      db, bus: bus(), registry: { get: () => undefined }, now: () => 100,
      launch: vi.fn(),
    });
    expect(runtime.backfill.workItemIds).toHaveLength(1);
    expect(runtime.recovery.recoveredRunKeys).toEqual(["legacy-live"]);
    expect(db.prepare(`SELECT run_outcome FROM sessions WHERE session_key = 'legacy-live'`).get())
      .toEqual({ run_outcome: "interrupted" });
    expect(runtime.workItems).toBeDefined();
  });

  it("launches primary and child runs with canonical lineage and worktree policy", async () => {
    const db = initDb(":memory:");
    const launched: StartSessionOptions[] = [];
    const parent = new SessionHost("parent-run", "/repo/.minions/worktrees/parent");
    parent.workItemId = "unused";
    parent.worktree = {
      path: parent.cwd,
      branch: "minions/parent",
      projectPath: "/repo",
      leaderSessionKey: "parent-run",
      createdAt: 1,
      lifecycle: "active",
    };
    const runtime = bootstrapWorkItemRuntime({
      db, bus: bus(), registry: { get: (key) => key === parent.id ? parent : undefined },
      launch: (options) => { launched.push(options); }, now: () => 10,
    });
    const detail = await runtime.workItems.create({
      requestId: "create", projectId: "project-1", projectPath: "/repo",
      title: "Isolated work", changeMode: "worktree",
    });
    await runtime.workItems.startRun({
      requestId: "primary", workItemId: detail.workItem.id, prompt: "Lead",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null,
    });
    expect(launched[0]).toMatchObject({
      workItemId: detail.workItem.id, runKind: "primary", parentRunKey: null,
      taskId: null, role: "leader", cwd: "/repo", worktreeIsolation: true,
      invocationKind: "new_run",
    });

    parent.workItemId = detail.workItem.id;
    await runtime.launchRun({
      workItemId: detail.workItem.id, runKey: "child-run", parentRunKey: "parent-run",
      taskId: "task-1", prompt: "Child", invocationKind: "new_run",
    });
    expect(launched[1]).toMatchObject({
      sessionKey: "child-run", workItemId: detail.workItem.id, runKind: "child",
      parentRunKey: "parent-run", taskId: "task-1", role: "minion",
      cwd: parent.cwd, worktreeIsolation: false, parentWorktree: parent.worktree,
    });
  });

  it("launches an observe-only harness in the atomically selected worktree mode", async () => {
    const db = initDb(":memory:"); const launched: StartSessionOptions[] = [];
    const runtime = bootstrapWorkItemRuntime({ db, bus: bus(), registry: { get: () => undefined },
      launch: (options) => { launched.push(options); }, now: () => 10 });
    const detail = await runtime.workItems.create({ requestId: "safe-create", projectId: "project",
      projectPath: "/repo", title: "Safe Codex", changeMode: "live" });
    const started = await runtime.workItems.startRun({ requestId: "safe-start",
      workItemId: detail.workItem.id, prompt: "Change files", harness: "codex",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    expect(started.workItem.lifecycle.changeMode).toBe("worktree");
    expect(launched[0]).toMatchObject({ harness: "codex", worktreeIsolation: true });
  });

  it("continues the exact hydrated host and provider thread", async () => {
    const db = initDb(":memory:");
    const launched: StartSessionOptions[] = [];
    const host = new SessionHost("run-1", "/repo/worktree");
    host.workItemId = "work-1";
    host.sessionId = "provider-1";
    host.harnessName = "codex";
    host.model = "gpt-5";
    host.permissionMode = "auto";
    const runtime = bootstrapWorkItemRuntime({
      db, bus: bus(), registry: { get: (key) => key === host.id ? host : undefined },
      launch: (options) => { launched.push(options); }, now: () => 10,
    });
    await runtime.continueRun({
      workItemId: "work-1", runKey: "run-1", prompt: "Continue",
      invocationKind: "resume_open_run", resumeId: "provider-1",
    });
    expect(launched).toEqual([expect.objectContaining({
      sessionKey: "run-1", workItemId: "work-1", resumeId: "provider-1",
      invocationKind: "resume_open_run", harness: "codex", initialModel: "gpt-5",
      cwd: "/repo/worktree",
    })]);
  });

  it("publishes a durable child key before provider launch", async () => {
    const db = initDb(":memory:");
    const hosts = new Map<string, SessionHost>();
    const allocated: string[] = [];
    const runtime = bootstrapWorkItemRuntime({
      db, bus: bus(), registry: { get: (key) => hosts.get(key) }, now: () => 10,
      launch: (options) => {
        if (options.runKind === "child") expect(allocated).toEqual([options.sessionKey]);
        const host = new SessionHost(options.sessionKey, options.cwd);
        host.workItemId = options.workItemId ?? null; hosts.set(options.sessionKey, host);
      },
    });
    const detail = await runtime.workItems.create({ requestId: "alloc-create",
      projectId: "project", projectPath: "/repo", title: "Allocation", changeMode: "live" });
    const primary = await runtime.workItems.startRun({ requestId: "alloc-primary",
      workItemId: detail.workItem.id, prompt: "Lead", expectedLifecycleRevision: 0,
      expectedCurrentRunKey: null });
    const unregister = runtime.registerChildAllocationCallback("alloc-child",
      (runKey) => allocated.push(runKey));
    const child = await runtime.workItems.startChildRun({ requestId: "alloc-child",
      workItemId: detail.workItem.id, parentRunKey: primary.workItem.currentRunKey!,
      taskId: "task", prompt: "Child", skillIds: ["review"] });
    unregister();
    expect(allocated).toEqual([child.runKey]);
  });
});
