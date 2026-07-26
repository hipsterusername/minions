import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import {
  WorkItemConflictError,
  archiveWorkItem,
  createWorkItem,
  getWorkItem,
  listWorkItemRuns,
  reviewWorkItem,
  restoreWorkItem,
  sealWorkItemRun,
  startWorkItemIteration,
} from "./work-item-repo.ts";
import { updateRunProviderSessionId } from "./work-item-provider-repo.ts";
import { attachWorkItemBinding, detachWorkItemBinding } from "./work-item-binding-repo.ts";
import { createChildWorkItemRun, sealChildWorkItemRun } from "./work-item-child-repo.ts";

function makeDb(): Database.Database {
  const db = initDb(":memory:");
  ensureWorkItemSchema(db);
  return db;
}

function seed(db: Database.Database, id = "work-1") {
  return createWorkItem(db, {
    id,
    projectId: "project-1",
    projectPath: "/repo",
    title: "Implement lifecycle",
    changeMode: "live",
    workflowRank: "a0",
    at: 10,
  });
}

describe("work-item repository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("creates a canonical draft and starts its first primary run atomically", () => {
    const draft = seed(db);
    const result = startWorkItemIteration(db, {
      workItemId: draft.id,
      runKey: "run-1",
      idempotencyKey: "start-1",
      expectedLifecycleRevision: 0,
      expectedCurrentRunKey: null,
      at: 20,
    });
    expect(result.idempotent).toBe(false);
    expect(result.workItem).toMatchObject({
      runtime_state: "starting", outcome: "none", resolution: "open",
      current_run_key: "run-1", iteration: 1, lifecycle_revision: 1,
    });
    expect(result.run).toMatchObject({
      session_key: "run-1", run_number: 1, run_kind: "primary",
      previous_run_key: null, ended_at: null, run_outcome: "none",
    });
  });

  it("archives a never-started draft card", () => {
    const draft = seed(db);
    const archived = archiveWorkItem(db, { workItemId: draft.id,
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20 });
    expect(archived.workItem).toMatchObject({ runtime_state: "draft", outcome: "none",
      resolution: "archived", current_run_key: null });
  });

  it("returns the original run for a retried idempotency key even with stale CAS", () => {
    const draft = seed(db);
    const input = {
      workItemId: draft.id,
      runKey: "run-1",
      idempotencyKey: "same-command",
      expectedLifecycleRevision: 0,
      expectedCurrentRunKey: null,
      at: 20,
    };
    startWorkItemIteration(db, input);
    const duplicate = startWorkItemIteration(db, { ...input, runKey: "different-run", at: 30 });
    expect(duplicate).toMatchObject({ idempotent: true, run: { session_key: "run-1" } });
    expect(listWorkItemRuns(db, draft.id)).toHaveLength(1);
  });

  it("rolls back run insertion when lifecycle revision or current run is stale", () => {
    const draft = seed(db);
    expect(() => startWorkItemIteration(db, {
      workItemId: draft.id,
      runKey: "orphan",
      idempotencyKey: "stale",
      expectedLifecycleRevision: 1,
      expectedCurrentRunKey: null,
      at: 20,
    })).toThrow(WorkItemConflictError);
    expect(listWorkItemRuns(db, draft.id)).toEqual([]);
    expect(getWorkItem(db, draft.id)?.current_run_key).toBeNull();
  });

  it("seals immutable run history and reopens into a linked new run", () => {
    const draft = seed(db);
    const first = startWorkItemIteration(db, {
      workItemId: draft.id, runKey: "run-1", idempotencyKey: "one",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    const sealed = sealWorkItemRun(db, {
      workItemId: draft.id, runKey: "run-1", outcome: "completed",
      finalReportEventId: "event-report-1", finalReport: "Done", expectedLifecycleRevision: 1,
      expectedCurrentRunKey: "run-1", at: 30,
    });
    expect(sealed.workItem).toMatchObject({ runtime_state: "inactive", outcome: "completed" });
    const reviewed = reviewWorkItem(db, {
      workItemId: draft.id, expectedLifecycleRevision: 2,
      expectedCurrentRunKey: "run-1", at: 40,
    });
    expect(db.prepare(`SELECT acknowledged_at, dismissed_at, lifecycle_revision
      FROM sessions WHERE session_key = 'run-1'`).get()).toEqual({
      acknowledged_at: 40, dismissed_at: null,
      lifecycle_revision: reviewed.workItem.lifecycle_revision,
    });
    const second = startWorkItemIteration(db, {
      workItemId: draft.id, runKey: "run-2", idempotencyKey: "two",
      expectedLifecycleRevision: reviewed.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 50,
    });
    expect(second.workItem).toMatchObject({
      runtime_state: "starting", outcome: "none", resolution: "open", iteration: 2,
    });
    expect(second.run).toMatchObject({ run_number: 2, previous_run_key: "run-1" });
    expect(listWorkItemRuns(db, draft.id)[0]).toMatchObject({
      ended_at: 30, run_outcome: "completed", final_report_event_id: "event-report-1",
    });
  });

  it("rejects sealing a completion without a durable final report", () => {
    seed(db);
    startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "run-1", idempotencyKey: "one",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    expect(() => sealWorkItemRun(db, {
      workItemId: "work-1", runKey: "run-1", outcome: "completed",
      expectedLifecycleRevision: 1, expectedCurrentRunKey: "run-1", at: 30,
    })).toThrow("completed runs require a durable final report event and content");
  });

  it("seals a deliberate stop as the stopped outcome", () => {
    seed(db);
    startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "run-1", idempotencyKey: "one",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    const sealed = sealWorkItemRun(db, {
      workItemId: "work-1", runKey: "run-1", outcome: "stopped",
      expectedLifecycleRevision: 1, expectedCurrentRunKey: "run-1", at: 30,
    });
    expect(sealed.run).toMatchObject({ run_outcome: "stopped" });
    expect(getWorkItem(db, "work-1")).toMatchObject({ outcome: "stopped", runtime_state: "inactive" });
  });

  it("makes sealing and resolution retries idempotent but rejects stale mutations", () => {
    seed(db);
    const start = startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "run-1", idempotencyKey: "one",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    const sealInput = {
      workItemId: "work-1", runKey: "run-1", outcome: "error" as const,
      expectedLifecycleRevision: start.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 30,
    };
    const sealed = sealWorkItemRun(db, sealInput);
    expect(sealWorkItemRun(db, sealInput).idempotent).toBe(true);
    const reviewed = reviewWorkItem(db, {
      workItemId: "work-1", expectedLifecycleRevision: sealed.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 40,
    });
    expect(() => reviewWorkItem(db, {
      workItemId: "work-1", expectedLifecycleRevision: 0,
      expectedCurrentRunKey: "run-1", at: 41,
    })).toThrow(WorkItemConflictError);
    expect(() => archiveWorkItem(db, {
      workItemId: "work-1", expectedLifecycleRevision: 0,
      expectedCurrentRunKey: "wrong-run", at: 50,
    })).toThrow(WorkItemConflictError);
    const archived = archiveWorkItem(db, {
      workItemId: "work-1", expectedLifecycleRevision: reviewed.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 50,
    });
    expect(archived.workItem.resolution).toBe("archived");
    expect(db.prepare(`SELECT acknowledged_at, dismissed_at, lifecycle_revision
      FROM sessions WHERE session_key = 'run-1'`).get()).toEqual({
      acknowledged_at: 40, dismissed_at: 50,
      lifecycle_revision: archived.workItem.lifecycle_revision,
    });
    const restored = restoreWorkItem(db, {
      workItemId: "work-1", expectedLifecycleRevision: archived.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 60,
    });
    expect(db.prepare(`SELECT acknowledged_at, dismissed_at, lifecycle_revision
      FROM sessions WHERE session_key = 'run-1'`).get()).toEqual({
      acknowledged_at: 40, dismissed_at: null,
      lifecycle_revision: restored.workItem.lifecycle_revision,
    });
  });

  it("no-ops when archiving an already-archived item instead of corrupting archived_from_resolution", () => {
    // Regression: the dismiss_session bound path re-reads the fresh revision, so a
    // double-dismiss reached writeLifecycle with resolution='archived' and blew up
    // on the CHECK (archived_from_resolution IN ('open', 'reviewed')) constraint.
    const draft = seed(db);
    const first = archiveWorkItem(db, { workItemId: draft.id,
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20 });
    expect(first.idempotent).toBe(false);
    const second = archiveWorkItem(db, { workItemId: draft.id,
      expectedLifecycleRevision: first.workItem.lifecycle_revision,
      expectedCurrentRunKey: null, at: 30 });
    expect(second.idempotent).toBe(true);
    expect(second.workItem).toMatchObject({
      resolution: "archived", archived_from_resolution: "open",
      lifecycle_revision: first.workItem.lifecycle_revision,
    });
  });

  it("keeps the original prior resolution across a repeated archive of a reviewed item", () => {
    seed(db);
    const start = startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "run-1", idempotencyKey: "one",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    const sealed = sealWorkItemRun(db, {
      workItemId: "work-1", runKey: "run-1", outcome: "completed",
      finalReportEventId: "event-1", finalReport: "Done",
      expectedLifecycleRevision: start.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 30,
    });
    const reviewed = reviewWorkItem(db, { workItemId: "work-1",
      expectedLifecycleRevision: sealed.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 40 });
    const archived = archiveWorkItem(db, { workItemId: "work-1",
      expectedLifecycleRevision: reviewed.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 50 });
    const again = archiveWorkItem(db, { workItemId: "work-1",
      expectedLifecycleRevision: archived.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 60 });
    expect(again.idempotent).toBe(true);
    expect(again.workItem.archived_from_resolution).toBe("reviewed");
    const restored = restoreWorkItem(db, { workItemId: "work-1",
      expectedLifecycleRevision: again.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 70 });
    expect(restored.workItem.resolution).toBe("reviewed");
  });

  it("no-ops a repeated review and a repeated restore", () => {
    seed(db);
    const start = startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "run-1", idempotencyKey: "one",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    const sealed = sealWorkItemRun(db, {
      workItemId: "work-1", runKey: "run-1", outcome: "completed",
      finalReportEventId: "event-1", finalReport: "Done",
      expectedLifecycleRevision: start.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 30,
    });
    const reviewed = reviewWorkItem(db, { workItemId: "work-1",
      expectedLifecycleRevision: sealed.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 40 });
    const reviewedAgain = reviewWorkItem(db, { workItemId: "work-1",
      expectedLifecycleRevision: reviewed.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 41 });
    expect(reviewedAgain.idempotent).toBe(true);
    expect(reviewedAgain.workItem.lifecycle_revision).toBe(reviewed.workItem.lifecycle_revision);
    const restoredNotArchived = restoreWorkItem(db, { workItemId: "work-1",
      expectedLifecycleRevision: reviewed.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 42 });
    expect(restoredNotArchived.idempotent).toBe(true);
    expect(restoredNotArchived.workItem.resolution).toBe("reviewed");
  });

  it("accepts only an exactly matching terminal seal retry", () => {
    seed(db);
    const start = startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "run-1", idempotencyKey: "one",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    const seal = {
      workItemId: "work-1", runKey: "run-1", outcome: "completed" as const,
      finalReportEventId: "report-event", finalReport: "Exact report",
      expectedLifecycleRevision: start.workItem.lifecycle_revision,
      expectedCurrentRunKey: "run-1", at: 30,
    };
    expect(sealWorkItemRun(db, seal).idempotent).toBe(false);
    expect(sealWorkItemRun(db, seal).idempotent).toBe(true);
    expect(() => sealWorkItemRun(db, { ...seal, finalReport: "Changed report" }))
      .toThrow("immutable");
    expect(() => sealWorkItemRun(db, { ...seal, outcome: "error" }))
      .toThrow("immutable");
  });

  it("allows concurrent child runs without changing the primary projection", () => {
    seed(db);
    const primary = startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "leader-run", idempotencyKey: "leader",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    const child1 = createChildWorkItemRun(db, {
      workItemId: "work-1", runKey: "child-1", parentRunKey: "leader-run",
      taskId: "task-1", idempotencyKey: "child-command-1", at: 21,
    });
    const child2 = createChildWorkItemRun(db, {
      workItemId: "work-1", runKey: "child-2", parentRunKey: "leader-run",
      taskId: "task-2", idempotencyKey: "child-command-2", at: 22,
    });
    expect([child1.run, child2.run]).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_kind: "child", parent_run_key: "leader-run", task_id: "task-1" }),
      expect.objectContaining({ run_kind: "child", parent_run_key: "leader-run", task_id: "task-2" }),
    ]));
    expect(getWorkItem(db, "work-1")?.current_run_key).toBe(primary.run?.session_key);
  });

  it("rejects a child whose primary parent is sealed and seals children independently", () => {
    seed(db);
    const primary = startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "leader-run", idempotencyKey: "leader",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    const child = createChildWorkItemRun(db, {
      workItemId: "work-1", runKey: "child", parentRunKey: "leader-run",
      taskId: "task", idempotencyKey: "child", at: 21,
    });
    expect(sealChildWorkItemRun(db, {
      workItemId: "work-1", runKey: "child", outcome: "completed",
      finalReportEventId: "event", finalReport: "done", at: 22,
    }).run).toMatchObject({ run_outcome: "completed", final_report: "done" });
    sealWorkItemRun(db, {
      workItemId: "work-1", runKey: "leader-run", outcome: "error",
      expectedLifecycleRevision: primary.workItem.lifecycle_revision,
      expectedCurrentRunKey: "leader-run", at: 23,
    });
    expect(() => createChildWorkItemRun(db, {
      workItemId: "work-1", runKey: "late", parentRunKey: "leader-run",
      taskId: "late", idempotencyKey: "late", at: 24,
    })).toThrow("invalid child-run parent");
    expect(child.run.run_kind).toBe("child");
  });

  it("updates provider identity only before sealing", () => {
    seed(db);
    startWorkItemIteration(db, {
      workItemId: "work-1", runKey: "run-1", idempotencyKey: "one",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
    });
    expect(updateRunProviderSessionId(db, "run-1", "provider-1", 1, 21)).toBe(true);
    expect(updateRunProviderSessionId(db, "run-1", "provider-2", 2, 22)).toBe(true);
    expect(updateRunProviderSessionId(db, "run-1", "provider-stale", 1, 23)).toBe(false);
    sealWorkItemRun(db, {
      workItemId: "work-1", runKey: "run-1", outcome: "error",
      expectedLifecycleRevision: 1, expectedCurrentRunKey: "run-1", at: 30,
    });
    expect(updateRunProviderSessionId(db, "run-1", "provider-2", 2, 31)).toBe(false);
    expect((db.prepare("SELECT session_id FROM sessions WHERE session_key = 'run-1'").get() as { session_id: string }).session_id)
      .toBe("provider-2");
  });

  it("attaches, detaches, and reattaches bindings without deleting history", () => {
    seed(db);
    attachWorkItemBinding(db, { workItemId: "work-1", surface: "canvas", bindingId: "node-1", at: 20 });
    detachWorkItemBinding(db, "work-1", "canvas", "node-1", 30);
    const detached = db.prepare("SELECT * FROM work_item_bindings").get() as { detached_at: number };
    expect(detached.detached_at).toBe(30);
    expect(attachWorkItemBinding(db, {
      workItemId: "work-1", surface: "canvas", bindingId: "node-1", at: 40,
    })).toMatchObject({ attached_at: 40, detached_at: null });
  });
});
