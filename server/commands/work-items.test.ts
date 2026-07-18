import { describe, expect, it, vi } from "vitest";
import { initialWorkItemLifecycle } from "../../shared/work-item-lifecycle.ts";
import { setup } from "../../tests/support/server-command-harness.ts";
import { dispatchCommand } from "./index.ts";
import type { WorkItemService } from "../work-item-service.ts";
import { WorkItemServiceError } from "../work-item-service.ts";

const detail = {
  workItem: {
    id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Task",
    lifecycle: initialWorkItemLifecycle(), waitKind: null, currentRunKey: null, iteration: 0,
    workflowColumnId: "backlog", workflowRank: "a", workflowRevision: 0,
    card: { description: "", subtasks: [], context: "", priority: "medium" as const,
      model: "", permissionMode: "auto", worktreeIsolation: false, skillIds: [],
      skillValues: {}, linkedContextNodeIds: [] }, lastTransitionAt: 1,
    createdAt: 1, updatedAt: 1,
  },
  bindings: [], currentRun: null, runs: [], nextCursor: null,
};

function service(): WorkItemService {
  return {
    create: vi.fn(async () => detail), startRun: vi.fn(async () => detail),
    replyToWaitingRun: vi.fn(async () => detail), review: vi.fn(async () => detail),
    archive: vi.fn(async () => detail), restore: vi.fn(async () => detail),
    attach: vi.fn(async () => detail), detach: vi.fn(async () => detail),
    updateCard: vi.fn(async () => detail), moveCard: vi.fn(async () => detail),
    importKanban: vi.fn(async () => ({ projectId: "project-1", items: [detail.workItem], nextCursor: null })),
    get: vi.fn(async () => detail),
    list: vi.fn(async () => ({ projectId: "project-1", items: [detail.workItem], nextCursor: null })),
    getRuns: vi.fn(async () => ({ workItemId: "work-1", runs: [], nextCursor: null })),
  };
}

describe("work-item command dispatcher", () => {
  it("enriches reconnect lists with volatile live-edit awareness", async () => {
    const h = setup(); h.ctx.workItems = service();
    h.ctx.getLiveEditAwareness = vi.fn(() => ({ "work-1": { runState: "waiting" as const,
      paths: ["src/a.ts"], queuePosition: 1, blockingRunKeys: ["run-2"],
      baselineConflict: false, updatedAt: 4 } }));
    dispatchCommand(h.ctx, { type: "list_work_items", projectId: "project-1" }, h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(h.ctx.getLiveEditAwareness).toHaveBeenCalledWith("/repo", ["work-1"]);
    expect(h.wsSent[0]).toMatchObject({ type: "work_item_response", success: true,
      result: { coordination: { "work-1": { queuePosition: 1,
        blockingRunKeys: ["run-2"] } } } });
  });

  it("rejects create when the registered path does not own the supplied project id", async () => {
    const h = setup();
    const workItems = service();
    h.ctx.workItems = workItems;
    h.ctx.resolveWorkItemProject = vi.fn(() => null);
    dispatchCommand(h.ctx, {
      type: "create_work_item", requestId: "00000000-0000-4000-8000-000000000001",
      projectId: "foreign-project", projectPath: "/repo", title: "Task", changeMode: "live",
    }, h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(workItems.create).not.toHaveBeenCalled();
    expect(h.wsSent[0]).toMatchObject({
      topic: "global", success: false, code: "validation_failed",
    });
  });

  it("passes the canonical path returned by the ownership seam to create", async () => {
    const h = setup();
    const workItems = service();
    h.ctx.workItems = workItems;
    h.ctx.resolveWorkItemProject = vi.fn(() => "/canonical/repo");
    dispatchCommand(h.ctx, {
      type: "create_work_item", requestId: "00000000-0000-4000-8000-000000000002",
      projectId: "project-1", projectPath: "/repo/../repo", title: "Task", changeMode: "live",
    }, h.ws);
    await vi.waitFor(() => expect(workItems.create).toHaveBeenCalledOnce());
    expect(workItems.create).toHaveBeenCalledWith(expect.objectContaining({ projectPath: "/canonical/repo" }));
  });

  it("delegates mutation input through the narrow service and replies on the item topic", async () => {
    const h = setup();
    const workItems = service();
    h.ctx.workItems = workItems;
    dispatchCommand(h.ctx, {
      type: "start_work_item_run", requestId: "00000000-0000-4000-8000-000000000003", workItemId: "work-1",
      prompt: "Implement", expectedLifecycleRevision: 3, expectedCurrentRunKey: null,
      harness: "codex", model: "gpt-5", permissionMode: "auto",
      thinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      skillIds: ["review"],
      skillValues: { review: { target: "api" } },
    }, h.ws);
    await vi.waitFor(() => expect(workItems.startRun).toHaveBeenCalledOnce());

    expect(workItems.startRun).toHaveBeenCalledWith({
      requestId: "00000000-0000-4000-8000-000000000003", workItemId: "work-1", prompt: "Implement",
      expectedLifecycleRevision: 3,
      expectedCurrentRunKey: null,
      harness: "codex", model: "gpt-5", permissionMode: "auto",
      thinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      skillIds: ["review"],
      skillValues: { review: { target: "api" } },
    });
    expect(h.wsSent[0]).toMatchObject({
      topic: "work-item:work-1", type: "work_item_response",
      command: "start_work_item_run", requestId: "00000000-0000-4000-8000-000000000003", success: true,
    });
  });

  it("dispatches workflow moves and canonical-path board imports", async () => {
    const h = setup(); const workItems = service(); h.ctx.workItems = workItems;
    h.ctx.resolveWorkItemProject = vi.fn(() => "/canonical/repo");
    dispatchCommand(h.ctx, { type: "move_work_item_card",
      requestId: "00000000-0000-4000-8000-000000000020", workItemId: "work-1",
      expectedWorkflowRevision: 2, columnId: "history", targetIndex: 0 }, h.ws);
    await vi.waitFor(() => expect(workItems.moveCard).toHaveBeenCalledOnce());
    expect(workItems.moveCard).toHaveBeenCalledWith({
      requestId: "00000000-0000-4000-8000-000000000020", workItemId: "work-1",
      expectedWorkflowRevision: 2, columnId: "history", targetIndex: 0 });

    dispatchCommand(h.ctx, { type: "import_kanban_board",
      requestId: "00000000-0000-4000-8000-000000000021", projectId: "project-1",
      projectPath: "/unclean", migrationKey: "local-storage-v1", cards: [] }, h.ws);
    await vi.waitFor(() => expect(workItems.importKanban).toHaveBeenCalledOnce());
    expect(workItems.importKanban).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: "/canonical/repo", migrationKey: "local-storage-v1" }));
  });

  it("returns an explicit unavailable response before repository injection", async () => {
    const h = setup();
    dispatchCommand(h.ctx, { type: "get_work_item", workItemId: "work-1" }, h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(h.wsSent[0]).toMatchObject({
      topic: "work-item:work-1", type: "work_item_response", success: false,
      error: "Work-item service is unavailable",
      code: "unavailable", latest: null,
    });
  });

  it("returns typed service conflicts with the latest snapshot", async () => {
    const h = setup();
    const workItems = service();
    workItems.archive = vi.fn(async () => {
      throw new WorkItemServiceError("conflict", "stale revision", detail);
    });
    h.ctx.workItems = workItems;
    dispatchCommand(h.ctx, {
      type: "archive_work_item", requestId: "request-2", workItemId: "work-1",
      expectedLifecycleRevision: 1, expectedCurrentRunKey: null,
    }, h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(h.wsSent[0]).toMatchObject({
      topic: "work-item:work-1", success: false, requestId: "request-2",
      code: "conflict", error: "stale revision", latest: detail,
    });
  });

  it("rejects malformed service results before emitting success", async () => {
    const h = setup();
    const workItems = service();
    workItems.get = vi.fn(async () => ({ invalid: true } as never));
    h.ctx.workItems = workItems;
    dispatchCommand(h.ctx, { type: "get_work_item", workItemId: "work-1" }, h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(h.wsSent[0]).toMatchObject({
      topic: "work-item:work-1", success: false, code: "internal",
      error: "Work-item command failed", latest: null,
    });
  });
});
