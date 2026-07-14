import { describe, expect, it, vi } from "vitest";
import type { WorkItemSnapshot } from "../../../shared/work-item-contracts.ts";
import { applyCanvasWorkItemSnapshot, canonicalPromptCommand, selectCanvasChangeMode,
  selectCanvasWorkItem } from "./work-item.ts";

function item(over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return {
    id: "work-1", projectId: "project", projectPath: "/repo", title: "Task",
    lifecycle: { runtimeState: "inactive", outcome: "completed", resolution: "open",
      changeMode: "live", integrationState: "live_clean", lifecycleRevision: 2 },
    waitKind: null, currentRunKey: "run-1", iteration: 1,
    workflowColumnId: "todo", workflowRank: "a", workflowRevision: 0,
    card: { description: "", subtasks: [], context: "", priority: "medium",
      model: "", permissionMode: "auto", worktreeIsolation: false, skillIds: [],
      skillValues: {}, linkedContextNodeIds: [] }, lastTransitionAt: 2,
    createdAt: 1, updatedAt: 2, ...over,
  };
}

describe("Canvas canonical work-item projection", () => {
  it("prefers the canonical change mode over the legacy leader setup flag", () => {
    expect(selectCanvasChangeMode({ worktreeIsolation: true,
      workItemSnapshot: item() })).toBe("live");
    expect(selectCanvasChangeMode({ worktreeIsolation: false,
      workItemSnapshot: item({ lifecycle: { ...item().lifecycle, changeMode: "worktree",
        integrationState: "worktree_active" } }) })).toBe("worktree");
    expect(selectCanvasChangeMode({ worktreeIsolation: false })).toBe("live");
  });

  it("uses the same shared lifecycle label as other surfaces", () => {
    expect(selectCanvasWorkItem(item())?.presentation.label).toBe("Ready for review");
    expect(selectCanvasWorkItem(item({ lifecycle: { ...item().lifecycle,
      runtimeState: "waiting", outcome: "none" }, waitKind: "decision" }))?.presentation.label)
      .toBe("Decision needed");
  });

  it("keeps one work item across distinct repeated iteration keys", () => {
    const first = applyCanvasWorkItemSnapshot({ workItemId: null }, item());
    const secondItem = item({ currentRunKey: "run-2", iteration: 2,
      lifecycle: { ...item().lifecycle, runtimeState: "starting", outcome: "none",
        lifecycleRevision: 3 } });
    const second = applyCanvasWorkItemSnapshot(first, secondItem);
    expect(second.workItemId).toBe("work-1");
    expect([first.currentRunKey, second.currentRunKey]).toEqual(["run-1", "run-2"]);
  });

  it("replies only to a waiting run and starts a new terminal iteration", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    expect(canonicalPromptCommand(item(), "again")).toMatchObject({
      type: "start_work_item_run", workItemId: "work-1", expectedCurrentRunKey: "run-1",
    });
    const waiting = item({ lifecycle: { ...item().lifecycle, runtimeState: "waiting", outcome: "none" },
      waitKind: "decision" });
    expect(canonicalPromptCommand(waiting, "answer")).toMatchObject({
      type: "reply_to_waiting_run", runKey: "run-1",
    });
    const fileWait = item({ lifecycle: { ...item().lifecycle, runtimeState: "waiting", outcome: "none" },
      waitKind: "file_conflict" });
    expect(canonicalPromptCommand(fileWait, "answer").type).toBe("start_work_item_run");
  });

  it("ignores a stale snapshot so a late event cannot roll the node back", () => {
    const current = { workItemId: "work-1", currentRunKey: "run-2",
      workItemSnapshot: item({ currentRunKey: "run-2", lifecycle: {
        ...item().lifecycle, lifecycleRevision: 5 } }) };
    expect(applyCanvasWorkItemSnapshot(current, item()).currentRunKey).toBe("run-2");
  });


  it("merges independent workflow and lifecycle revisions without rolling either back", () => {
    const lifecycle = item({ title: "old", workflowRevision: 2, currentRunKey: "run-5",
      lifecycle: { ...item().lifecycle, lifecycleRevision: 5, runtimeState: "waiting", outcome: "none" },
      waitKind: "decision" });
    const workflow = item({ title: "new", workflowRevision: 3, workflowColumnId: "done",
      lifecycle: { ...item().lifecycle, lifecycleRevision: 4 } });
    const merged = applyCanvasWorkItemSnapshot({ workItemId: "work-1", currentRunKey: "run-5",
      workItemSnapshot: lifecycle }, workflow).workItemSnapshot;
    expect(merged).toMatchObject({ title: "new", workflowRevision: 3, workflowColumnId: "done",
      currentRunKey: "run-5", waitKind: "decision",
      lifecycle: { lifecycleRevision: 5, runtimeState: "waiting" } });
  });
});
