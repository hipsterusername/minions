import { describe, expect, it } from "vitest";
import { initialWorkItemLifecycle, selectWorkItemPresentation } from "../shared/work-item-lifecycle.ts";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import { initialWorkItemClientState, mergeCanonicalActivity, mergeWorkItemSnapshot, reduceWorkItems } from "./use-work-items.ts";

function item(id: string, revision: number, updatedAt = revision): WorkItemSnapshot {
  return { id, projectId: "p1", projectPath: "/repo", title: `Task ${id}`,
    lifecycle: { ...initialWorkItemLifecycle(), runtimeState: "working", lifecycleRevision: revision },
    waitKind: null, currentRunKey: `run-${id}`, iteration: 1,
    workflowColumnId: "backlog", workflowRank: id, workflowRevision: 0,
    card: { description: "", subtasks: [], context: "", priority: "medium", model: "",
      permissionMode: "auto", worktreeIsolation: false, skillIds: [], skillValues: {},
      linkedContextNodeIds: [] }, lastTransitionAt: updatedAt,
    createdAt: 1, updatedAt };
}

describe("canonical client work-item state", () => {
  it("keeps newer lifecycle state when a newer workflow event arrives second", () => {
    const lifecycle: WorkItemSnapshot = { ...item("a", 5, 50), title: "Old title", workflowRevision: 2 };
    lifecycle.lifecycle = { ...lifecycle.lifecycle, runtimeState: "waiting" };
    lifecycle.waitKind = "decision";
    lifecycle.currentRunKey = "run-new";
    lifecycle.iteration = 5;
    const workflow: WorkItemSnapshot = { ...item("a", 4, 60), title: "New title", workflowRevision: 3,
      workflowColumnId: "done", workflowRank: "z", card: { ...lifecycle.card, description: "new" } };
    const merged = mergeWorkItemSnapshot(lifecycle, workflow);
    expect(merged).toMatchObject({ title: "New title", workflowRevision: 3,
      workflowColumnId: "done", lifecycle: { lifecycleRevision: 5, runtimeState: "waiting" },
      waitKind: "decision", currentRunKey: "run-new", iteration: 5, updatedAt: 60 });
  });

  it("keeps newer workflow state when a newer lifecycle event arrives second", () => {
    const workflow: WorkItemSnapshot = { ...item("a", 4, 70), title: "New title", workflowRevision: 8,
      workflowColumnId: "review", workflowRank: "zz", card: { ...item("a", 1).card, priority: "critical" as const } };
    const lifecycle: WorkItemSnapshot = { ...item("a", 5, 65), title: "Stale title", workflowRevision: 7 };
    lifecycle.lifecycle = { ...lifecycle.lifecycle, outcome: "completed", runtimeState: "inactive" };
    lifecycle.currentRunKey = "run-5";
    lifecycle.iteration = 5;
    const merged = mergeWorkItemSnapshot(workflow, lifecycle);
    expect(merged).toMatchObject({ title: "New title", workflowRevision: 8,
      workflowColumnId: "review", workflowRank: "zz", card: { priority: "critical" },
      lifecycle: { lifecycleRevision: 5, outcome: "completed" }, currentRunKey: "run-5",
      iteration: 5, updatedAt: 70 });
  });

  it("replaces state on reconnect list and ignores out-of-order events", () => {
    const listed = reduceWorkItems(initialWorkItemClientState, {
      type: "work_item_response", command: "list_work_items", requestId: null,
      success: true, result: { projectId: "p1", items: [item("a", 3)], nextCursor: null },
    });
    const stale = reduceWorkItems(listed, {
      type: "work_item_changed", workItem: item("a", 2), revision: 2, cause: "late", timestamp: 2,
    });
    expect(stale).toBe(listed);
    const reconnected = reduceWorkItems(listed, {
      type: "work_item_response", command: "list_work_items", requestId: null,
      success: true, result: { projectId: "p1", items: [item("b", 1)], nextCursor: null },
    });
    expect(Object.keys(reconnected.items)).toEqual(["b"]);
  });

  it("hydrates stationary volatile queue awareness from reconnect list", () => {
    const awareness = { runState: "waiting" as const, paths: ["src/a.ts"],
      queuePosition: 2, blockingRunKeys: ["run-b"], baselineConflict: false, updatedAt: 9 };
    const state = reduceWorkItems(initialWorkItemClientState, {
      type: "work_item_response", command: "list_work_items", requestId: null,
      success: true, result: { projectId: "p1", items: [item("a", 3)], nextCursor: null,
        coordination: { a: awareness } },
    });
    expect(state.coordination["a"]).toEqual(awareness);
    expect(mergeCanonicalActivity([], [item("a", 3)], state.coordination)[0]?.lastActivity)
      .toContain("queue #2");
  });

  it("accepts workflow-only events without requiring a lifecycle revision bump", () => {
    const listed = reduceWorkItems(initialWorkItemClientState, {
      type: "work_item_response", command: "list_work_items", requestId: null,
      success: true, result: { projectId: "p1", items: [item("a", 3)], nextCursor: null },
    });
    const moved = item("a", 3); moved.workflowRevision = 1; moved.workflowColumnId = "history";
    const next = reduceWorkItems(listed, { type: "work_item_changed", workItem: moved,
      revision: 3, cause: "card_moved", timestamp: 4 });
    expect(next.items["a"]?.workflowColumnId).toBe("history");
  });

  it("adds a newly created work item without waiting for a list refresh", () => {
    const created = reduceWorkItems({ ...initialWorkItemClientState, projectId: "p1" }, {
      type: "work_item_created", workItem: item("new", 0), timestamp: 2,
    });
    expect(created.items["new"]?.id).toBe("new");
  });

  it("canonical items win over legacy rows, dedupe by workItemId, and order by update time", () => {
    const sessions = [{ sessionKey: "old", sessionId: null, workItemId: "a", status: "idle", cwd: "/repo" },
      { sessionKey: "legacy", sessionId: null, status: "idle", cwd: "/repo" }];
    const merged = mergeCanonicalActivity(sessions, [item("a", 2, 20), item("b", 1, 10)]);
    expect(merged.map((row) => row.workItemId ?? row.sessionKey)).toEqual(["a", "b", "legacy"]);
    expect(merged[0]).toMatchObject({ taskName: "Task a", lastActivity: "Working", status: "running" });
  });

  it("uses the shared presentation projection for cross-surface labels and visibility", () => {
    const archived = item("a", 2);
    archived.lifecycle = { ...archived.lifecycle, runtimeState: "inactive", resolution: "archived" };
    const [row] = mergeCanonicalActivity([], [archived]);
    expect(row?.lastActivity).toBe(selectWorkItemPresentation(archived.lifecycle).label);
    expect(row?.reviewLifecycle?.dismissedAt).not.toBeNull();
  });

  it("does not project generic or file waits as decision-needed", () => {
    for (const waitKind of ["file_conflict", "other"] as const) {
      const waiting = item(waitKind, 2);
      waiting.lifecycle = { ...waiting.lifecycle, runtimeState: "waiting" };
      waiting.waitKind = waitKind;
      const [row] = mergeCanonicalActivity([], [waiting]);
      expect(row?.reviewLifecycle?.reviewState).toBe("none");
      expect(row?.lastActivity).not.toBe("Decision needed");
    }
  });

  it("accumulates immutable run pages and tracks the next cursor", () => {
    const run = (runKey: string, startedAt: number) => ({ runKey, workItemId: "a",
      runKind: "primary" as const, parentRunKey: null, taskId: null, runNumber: startedAt,
      previousRunKey: null, providerSessionId: null, outcome: "completed" as const,
      startedAt, endedAt: startedAt + 1, finalReport: `Report ${runKey}` });
    const first = reduceWorkItems(initialWorkItemClientState, {
      type: "work_item_response", command: "get_work_item_runs", requestId: null, success: true,
      result: { workItemId: "a", runs: [run("r2", 2)], nextCursor: "page-2" },
    });
    const second = reduceWorkItems(first, {
      type: "work_item_response", command: "get_work_item_runs", requestId: null, success: true,
      result: { workItemId: "a", runs: [run("r1", 1), run("r2", 2)], nextCursor: null },
    });
    expect(second.runs["a"]?.map((entry) => entry.runKey)).toEqual(["r2", "r1"]);
    expect(second.runNextCursor["a"]).toBeNull();
  });
});
