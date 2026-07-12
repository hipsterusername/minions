import { describe, expect, it } from "vitest";
import { initialWorkItemLifecycle } from "../../shared/work-item-lifecycle.ts";
import {
  workItemBindingSnapshotSchema,
  workItemDetailSnapshotSchema,
  workItemRunSnapshotSchema,
  workItemSnapshotSchema,
} from "../../shared/work-item-contracts.ts";
import {
  topicSchema,
  workItemBindingChangedEnvelopeSchema,
  workItemChangedEnvelopeSchema,
  workItemCreatedEnvelopeSchema,
  workItemResponseEnvelopeSchema,
  workItemRunCreatedEnvelopeSchema,
  workItemRunSealedEnvelopeSchema,
  workItemTopic,
} from "../../shared/ws-envelope.ts";

const workItem = {
  id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Ship lifecycle",
  lifecycle: initialWorkItemLifecycle(), waitKind: null, currentRunKey: null, iteration: 0,
  workflowColumnId: "backlog", workflowRank: "a", workflowRevision: 0,
  card: { description: "", subtasks: [], context: "", priority: "medium" as const,
    model: "", permissionMode: "auto", worktreeIsolation: false,
    skillIds: [], skillValues: {}, linkedContextNodeIds: [] },
  lastTransitionAt: 1,
  createdAt: 1, updatedAt: 1,
};
const run = {
  runKey: "run-1", workItemId: "work-1", runNumber: 1, previousRunKey: null,
  runKind: "primary" as const, parentRunKey: null, taskId: null,
  providerSessionId: null, outcome: "none" as const, startedAt: 2, endedAt: null,
  finalReport: null,
};
const binding = {
  workItemId: "work-1", surface: "canvas" as const, bindingId: "node-1",
  attachedAt: 3, detachedAt: null,
};

describe("work-item snapshot contracts", () => {
  it("parses canonical item, run, binding, and detail snapshots", () => {
    expect(workItemSnapshotSchema.parse(workItem)).toEqual(workItem);
    expect(workItemRunSnapshotSchema.parse(run)).toEqual(run);
    expect(workItemBindingSnapshotSchema.parse(binding)).toEqual(binding);
    expect(workItemDetailSnapshotSchema.safeParse({
      workItem, bindings: [binding], currentRun: run, runs: [run], nextCursor: null,
    }).success).toBe(true);
  });

  it("rejects a snapshot that violates shared lifecycle invariants", () => {
    expect(workItemSnapshotSchema.safeParse({
      ...workItem,
      lifecycle: { ...workItem.lifecycle, runtimeState: "working", outcome: "completed" },
    }).success).toBe(false);
  });

  it("enforces primary/child lineage and terminal consistency", () => {
    expect(workItemRunSnapshotSchema.safeParse({ ...run, runKind: "child" }).success).toBe(false);
    expect(workItemRunSnapshotSchema.safeParse({
      ...run, runKey: "child-1", runKind: "child", runNumber: null,
      parentRunKey: "run-1", taskId: "task-1",
    }).success).toBe(true);
    expect(workItemRunSnapshotSchema.safeParse({
      ...run, outcome: "completed", endedAt: 5, finalReport: null,
    }).success).toBe(false);
    expect(workItemRunSnapshotSchema.safeParse({
      ...run, outcome: "error", endedAt: null,
    }).success).toBe(false);
  });
});

describe("work-item topics and event envelopes", () => {
  it("builds and validates work-item topics", () => {
    expect(workItemTopic("work-1")).toBe("work-item:work-1");
    expect(topicSchema.safeParse("work-item:work-1").success).toBe(true);
    expect(() => workItemTopic("")).toThrow("workItemId");
  });

  it("validates every Phase 1 work-item event snapshot", () => {
    const base = { topic: "work-item:work-1", timestamp: 4 };
    expect(workItemChangedEnvelopeSchema.safeParse({
      ...base, type: "work_item_changed", workItem, revision: 0, cause: "created",
    }).success).toBe(true);
    expect(workItemCreatedEnvelopeSchema.safeParse({
      ...base, type: "work_item_created", workItem,
    }).success).toBe(true);
    expect(workItemRunCreatedEnvelopeSchema.safeParse({
      ...base, type: "work_item_run_created", workItemId: "work-1", run,
    }).success).toBe(true);
    expect(workItemRunSealedEnvelopeSchema.safeParse({
      ...base, type: "work_item_run_sealed", workItemId: "work-1",
      run: { ...run, outcome: "completed", endedAt: 5, finalReport: "Done" },
    }).success).toBe(true);
    expect(workItemBindingChangedEnvelopeSchema.safeParse({
      ...base, type: "work_item_binding_changed", workItemId: "work-1", binding,
    }).success).toBe(true);
    expect(workItemResponseEnvelopeSchema.safeParse({
      ...base, type: "work_item_response", command: "get_work_item",
      requestId: null, success: true,
      result: { workItem, bindings: [binding], currentRun: run, runs: [run], nextCursor: null },
    }).success).toBe(true);
  });

  it("rejects mismatched event identities and revisions", () => {
    expect(workItemChangedEnvelopeSchema.safeParse({
      topic: "work-item:other", type: "work_item_changed", workItem,
      revision: 0, cause: "changed", timestamp: 5,
    }).success).toBe(false);
    expect(workItemChangedEnvelopeSchema.safeParse({
      topic: "work-item:work-1", type: "work_item_changed", workItem,
      revision: 9, cause: "changed", timestamp: 5,
    }).success).toBe(false);
    expect(workItemRunCreatedEnvelopeSchema.safeParse({
      topic: "work-item:work-1", type: "work_item_run_created",
      workItemId: "other", run, timestamp: 5,
    }).success).toBe(false);
    expect(workItemBindingChangedEnvelopeSchema.safeParse({
      topic: "work-item:work-1", type: "work_item_binding_changed",
      workItemId: "work-1", binding: { ...binding, workItemId: "other" }, timestamp: 5,
    }).success).toBe(false);
  });

  it("discriminates successful and failed command responses", () => {
    const base = {
      topic: "work-item:work-1", type: "work_item_response",
      command: "get_work_item", requestId: "req-1",
    };
    expect(workItemResponseEnvelopeSchema.safeParse({
      ...base, success: false, error: "stale", code: "conflict", latest: null,
    }).success).toBe(true);
    expect(workItemResponseEnvelopeSchema.safeParse({
      ...base, success: false, error: "stale",
    }).success).toBe(false);
    expect(workItemResponseEnvelopeSchema.safeParse({
      ...base, success: true, error: "cannot coexist", result: null,
    }).success).toBe(false);
  });
});
