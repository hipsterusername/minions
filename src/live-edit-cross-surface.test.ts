import { describe, expect, it } from "vitest";
import { initialWorkItemLifecycle } from "../shared/work-item-lifecycle.ts";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import type { LiveEditAwareness } from "../shared/live-edit-coordination.ts";
import { formatCanvasWorkItemStatus } from "./nodes/leader/work-item.ts";
import { mergeCanonicalActivity } from "./use-work-items.ts";
import { projectKanbanWorkItemStatus } from "./kanban-work-item-status.ts";

describe("live-edit cross-surface projection", () => {
  it("renders identical canonical label and FIFO detail in Activity, Canvas, and Kanban", () => {
    const item = { id: "work-1", projectId: "project", projectPath: "/repo", title: "Task",
      lifecycle: { ...initialWorkItemLifecycle(), runtimeState: "working",
        integrationState: "live_conflict_wait", lifecycleRevision: 2 }, waitKind: null,
      currentRunKey: "run-1", iteration: 1, workflowColumnId: "in-progress",
      workflowRank: "a", workflowRevision: 0, card: {}, lastTransitionAt: 1,
      createdAt: 1, updatedAt: 2 } as WorkItemSnapshot;
    const awareness: LiveEditAwareness = { runState: "waiting", paths: ["src/a.ts"],
      queuePosition: 2, blockingRunKeys: ["run-2"], baselineConflict: false, updatedAt: 3 };
    const kanban = projectKanbanWorkItemStatus(item, awareness).presentationLabel;
    const canvas = formatCanvasWorkItemStatus(item, awareness);
    const activity = mergeCanonicalActivity([], [item], { "work-1": awareness })[0]!.lastActivity;
    expect([activity, canvas, kanban]).toEqual([
      "Waiting for files · src/a.ts · queue #2 · blocked by run-2",
      "Waiting for files · src/a.ts · queue #2 · blocked by run-2",
      "Waiting for files · src/a.ts · queue #2 · blocked by run-2",
    ]);
  });
});
