import { describe, expect, it } from "vitest";
import { initialWorkItemLifecycle, selectWorkItemPresentation } from "../shared/work-item-lifecycle.ts";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import { initialWorkItemClientState, mergeCanonicalActivity, mergeWorkItemListPage,
  activityEntryId, mergeWorkItemSnapshot, reduceWorkItems } from "./use-work-items.ts";

function item(id: string, revision: number, updatedAt = revision): WorkItemSnapshot {
  return { id, projectId: "p1", projectPath: "/repo", title: `Task ${id}`,
    lifecycle: { ...initialWorkItemLifecycle(), runtimeState: "working", lifecycleRevision: revision },
    waitKind: null, currentRunKey: `run-${id}`, iteration: 1,
    lastTransitionAt: updatedAt,
    createdAt: 1, updatedAt };
}

describe("canonical client work-item state", () => {
  it("accepts a newer lifecycle snapshot and ignores an older one", () => {
    const current = item("a", 4, 40);
    const incoming = item("a", 5, 50);
    incoming.title = "Updated title";
    incoming.lifecycle = { ...incoming.lifecycle, runtimeState: "waiting" };
    incoming.waitKind = "decision";
    expect(mergeWorkItemSnapshot(current, incoming)).toMatchObject({
      title: "Updated title",
      lifecycle: { lifecycleRevision: 5, runtimeState: "waiting" },
      waitKind: "decision",
      updatedAt: 50,
    });
    expect(mergeWorkItemSnapshot(incoming, current)).toBe(incoming);
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

  it("accumulates paged refresh results without losing newer live state", () => {
    const first = mergeWorkItemListPage(initialWorkItemClientState, {
      projectId: "p1", items: [item("newest", 3, 30)], nextCursor: "page-2",
    }, true);
    const live = reduceWorkItems(first, {
      type: "work_item_changed", workItem: item("newest", 4, 40),
      revision: 4, cause: "live", timestamp: 40,
    });
    const complete = mergeWorkItemListPage(live, {
      projectId: "p1", items: [item("older", 2, 20), item("newest", 3, 30)],
      nextCursor: null,
    }, false);
    expect(Object.keys(complete.items).sort()).toEqual(["newest", "older"]);
    expect(complete.items["newest"]?.lifecycle.lifecycleRevision).toBe(4);
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

  it("self-heals a tracked item from the latest snapshot on a failed mutation", () => {
    // Regression: a conflict rejection ("stale work-item lifecycle") carries the
    // authoritative snapshot in `latest`, but the store previously discarded it,
    // so every subsequent click re-sent the same stale fences and failed again.
    const listed = reduceWorkItems(initialWorkItemClientState, {
      type: "work_item_response", command: "list_work_items", requestId: null,
      success: true, result: { projectId: "p1", items: [item("a", 3)], nextCursor: null },
    });
    const healed = reduceWorkItems(listed, {
      type: "work_item_response", command: "archive_work_item", requestId: "req-1",
      success: false, error: "stale work-item lifecycle", code: "conflict",
      latest: { workItem: item("a", 7), bindings: [], currentRun: null, runs: [], nextCursor: null },
    } as never);
    expect(healed.items["a"]?.lifecycle.lifecycleRevision).toBe(7);
    const untracked = reduceWorkItems(listed, {
      type: "work_item_response", command: "archive_work_item", requestId: "req-2",
      success: false, error: "stale work-item lifecycle", code: "conflict",
      latest: { workItem: item("other", 2), bindings: [], currentRun: null, runs: [], nextCursor: null },
    } as never);
    expect(untracked.items["other"]).toBeUndefined();
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

  it("collapses persisted iterations before canonical work-item hydration", () => {
    const sessions = [
      { sessionKey: "run-1", sessionId: null, workItemId: "a", runKind: "primary" as const,
        role: "leader" as const, status: "completed", cwd: "/repo", lastActivityAt: 10 },
      { sessionKey: "child", sessionId: null, workItemId: "a", runKind: "child" as const,
        role: "minion" as const, status: "running", cwd: "/repo", lastActivityAt: 30 },
      { sessionKey: "run-2", sessionId: null, workItemId: "a", runKind: "primary" as const,
        role: "leader" as const, status: "running", cwd: "/repo", lastActivityAt: 20 },
      { sessionKey: "legacy", sessionId: null, status: "idle", cwd: "/repo", lastActivityAt: 30 },
    ];
    const merged = mergeCanonicalActivity(sessions, []);
    expect(merged.map((row) => row.sessionKey)).toEqual(["run-2", "legacy"]);
    expect(activityEntryId(merged[0]!)).toBe("work-item:a");
    expect(activityEntryId(merged[1]!)).toBe("session:legacy");
  });

  it("flags canonical entries so lifecycle actions use the work-item revision space", () => {
    // Canonical entries carry the work item's lifecycleRevision, so lifecycle
    // actions may fence work-item commands with it. Fallback sessions (work
    // item not in the loaded list — e.g. legacy projectId orphans) carry the
    // session's own revision and must NOT be flagged, or dismiss/ack would be
    // rejected server-side as "stale work-item lifecycle".
    const sessions = [{ sessionKey: "orphan-run", sessionId: null,
      workItemId: "missing-item", status: "idle", cwd: "/repo" }];
    const merged = mergeCanonicalActivity(sessions, [item("a", 2, 20)]);
    const canonical = merged.find((row) => row.workItemId === "a");
    const fallback = merged.find((row) => row.workItemId === "missing-item");
    expect(canonical?.canonicalWorkItem).toBe(true);
    expect(fallback?.canonicalWorkItem).toBeUndefined();
  });

  it("uses the shared presentation projection for cross-surface labels and visibility", () => {
    const archived = item("a", 2);
    archived.lifecycle = { ...archived.lifecycle, runtimeState: "inactive", resolution: "archived" };
    const [row] = mergeCanonicalActivity([], [archived]);
    expect(row?.lastActivity).toBe(selectWorkItemPresentation(archived.lifecycle).label);
    expect(row?.reviewLifecycle?.dismissedAt).not.toBeNull();
  });

  it("preserves a genuine interrupted outcome in Activity", () => {
    const inactive = item("inactive", 3);
    inactive.lifecycle = {
      ...inactive.lifecycle,
      runtimeState: "inactive",
      outcome: "interrupted",
    };
    const [row] = mergeCanonicalActivity([], [inactive]);
    expect(row).toMatchObject({
      status: "inactive",
      lastActivity: "Interrupted",
      reviewLifecycle: {
        reviewState: "interrupted_to_review",
        reviewReason: "Interrupted",
      },
    });
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
