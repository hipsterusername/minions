// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialWorkItemLifecycle } from "../shared/work-item-lifecycle.ts";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";
import { boardToKanbanImport, projectWorkItemsToKanban, useServerKanban } from "./use-server-kanban.ts";
import { DEFAULT_COLUMNS, type KanbanBoard } from "./kanban-types.ts";

function item(): WorkItemSnapshot {
  return { id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Card",
    lifecycle: initialWorkItemLifecycle(), waitKind: null, currentRunKey: null, iteration: 0,
    workflowColumnId: "history", workflowRank: "1", workflowRevision: 2,
    card: { description: "Details", subtasks: [], context: "Context", priority: "high",
      model: "gpt-5", harness: "codex", permissionMode: "auto", worktreeIsolation: false,
      skillIds: ["review"], skillValues: {}, linkedContextNodeIds: [], agentSummary: "Done" },
    lastTransitionAt: 1, createdAt: 1, updatedAt: 2 };
}

describe("server-backed Kanban adapter", () => {
  beforeEach(() => localStorage.clear());

  it("projects canonical workflow placement and preserved card history", () => {
    expect(projectWorkItemsToKanban([item()]).cards[0]).toMatchObject({
      id: "work-1", columnId: "history", description: "Details",
      harness: "codex", agentSummary: "Done" });
    const archived = item(); archived.lifecycle = { ...archived.lifecycle,
      runtimeState: "inactive", resolution: "archived" };
    expect(projectWorkItemsToKanban([archived]).cards).toEqual([]);
  });

  it("creates stable per-column import ranks without dropping legacy fields", () => {
    const board: KanbanBoard = { columns: DEFAULT_COLUMNS, cards: [
      { ...projectWorkItemsToKanban([item()]).cards[0]!, id: "legacy-a" },
      { ...projectWorkItemsToKanban([item()]).cards[0]!, id: "legacy-b" },
    ] };
    board.cards[0] = { ...board.cards[0]!, leaderNodeId: "node-1" };
    expect(boardToKanbanImport(board, new Map([["node-1", "work-existing"]]))).toEqual([
      expect.objectContaining({ id: "legacy-a", rank: "00000000", agentSummary: "Done",
        existingWorkItemId: "work-existing" }),
      expect.objectContaining({ id: "legacy-b", rank: "00000001", agentSummary: "Done" }),
    ]);
  });

  it("isolates project switches and retries an unmarked failed migration on reconnect", () => {
    const legacy = projectWorkItemsToKanban([item()]);
    localStorage.setItem("kanban-project-a", JSON.stringify(legacy));
    localStorage.setItem("kanban-project-b", JSON.stringify(legacy));
    const send = vi.fn(); let listener: ((message: ServerMessage) => void) | undefined;
    const subscribe = ((_: string, fn: (message: ServerMessage) => void) => {
      listener = fn; return () => {};
    }) as SocketSubscribe;
    const { result, rerender } = renderHook(({ projectId, connected }) => useServerKanban({
      projectId, projectPath: `/${projectId}`, connected, items: [item()], send, subscribe,
    }), { initialProps: { projectId: "project-a", connected: true } });
    const first = send.mock.calls[0]?.[0] as { requestId: string; projectId: string };
    expect(first.projectId).toBe("project-a");
    rerender({ projectId: "project-b", connected: true });
    expect(result.current.board.cards).toEqual([]);
    const second = send.mock.calls[1]?.[0] as { requestId: string; projectId: string };
    expect(second.projectId).toBe("project-b");
    act(() => listener?.({ type: "work_item_response", command: "import_kanban_board",
      requestId: first.requestId, success: true, result: {} }));
    expect(localStorage.getItem("kanban-server-migrated-project-a")).toBeNull();
    expect(localStorage.getItem("kanban-server-migrated-project-b")).toBeNull();
    act(() => listener?.({ type: "work_item_response", command: "import_kanban_board",
      requestId: second.requestId, success: false, error: "temporary" }));
    rerender({ projectId: "project-b", connected: false });
    rerender({ projectId: "project-b", connected: true });
    const retry = send.mock.calls[2]?.[0] as { requestId: string; projectId: string };
    expect(retry).toMatchObject({ projectId: "project-b" });
    expect(retry.requestId).not.toBe(second.requestId);
    act(() => listener?.({ type: "work_item_response", command: "import_kanban_board",
      requestId: retry.requestId, success: true, result: {} }));
    expect(localStorage.getItem("kanban-server-migrated-project-b")).toBe("local-storage-v1");
  });

  it("retries migration safely and emits workflow-CAS move/update commands", () => {
    const legacy = projectWorkItemsToKanban([item()]);
    legacy.cards[0] = { ...legacy.cards[0]!, id: "legacy" };
    localStorage.setItem("kanban-project-1", JSON.stringify(legacy));
    const send = vi.fn(); let listener: ((message: ServerMessage) => void) | undefined;
    const subscribe = ((_: string, fn: (message: ServerMessage) => void) => {
      listener = fn; return () => {};
    }) as SocketSubscribe;
    const { result } = renderHook(() => useServerKanban({ projectId: "project-1",
      projectPath: "/repo", connected: true, items: [item()], send, subscribe }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "import_kanban_board",
      migrationKey: "local-storage-v1", cards: [expect.objectContaining({ id: "legacy" })] }));
    const importRequest = send.mock.calls[0]?.[0] as { requestId: string };
    act(() => listener?.({ type: "work_item_response", command: "import_kanban_board",
      requestId: importRequest.requestId, success: true, result: {} }));
    expect(localStorage.getItem("kanban-server-migrated-project-1")).toBe("local-storage-v1");
    act(() => result.current.dispatch({ type: "MOVE_CARD", cardId: "work-1",
      targetColumnId: "in-progress", targetIndex: 1 }));
    act(() => result.current.dispatch({ type: "UPDATE_CARD", cardId: "work-1",
      data: { title: "Updated", priority: "critical" } }));
    act(() => result.current.dispatch({ type: "ADD_CARD", card: {
      ...projectWorkItemsToKanban([item()]).cards[0]!, id: "temporary", title: "New" } }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "move_work_item_card",
      expectedWorkflowRevision: 2, columnId: "in-progress" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "update_work_item_card",
      expectedWorkflowRevision: 2, title: "Updated", cardPatch: { priority: "critical" } }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "create_work_item",
      title: "New", cardPatch: expect.objectContaining({ description: "Details" }) }));
    act(() => result.current.dispatch({ type: "ADD_SUBTASK", cardId: "work-1",
      subtask: { id: "sub", title: "Check", done: false } }));
    act(() => result.current.dispatch({ type: "BIND_LEADER", cardId: "work-1", leaderNodeId: "node-1" }));
    act(() => result.current.dispatch({ type: "COMPLETE_CARD", cardId: "work-1",
      summary: "Shipped", cost: 1 }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "update_work_item_card",
      cardPatch: { subtasks: [{ id: "sub", title: "Check", done: false }] } }));
    const bindingAttach = send.mock.calls.map(([command]) => command as {
      type: string; requestId: string; bindingId?: string })
      .find((command) => command.type === "attach_work_item_surface"
        && command.bindingId === "node-1")!;
    act(() => listener?.({ type: "work_item_response", command: "attach_work_item_surface",
      requestId: bindingAttach.requestId, success: true,
      result: { workItem: { ...item(), workflowRevision: 6 } } }));
    const bindingUpdate = send.mock.calls.map(([command]) => command as {
      type: string; requestId: string; cardPatch?: { leaderNodeId?: string } })
      .find((command) => command.type === "update_work_item_card"
        && command.cardPatch?.leaderNodeId === "node-1")!;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "attach_work_item_surface",
      surface: "canvas", bindingId: "node-1" }));
    act(() => listener?.({ type: "work_item_response", command: "update_work_item_card",
      requestId: bindingUpdate.requestId, success: true,
      result: { workItem: { ...item(), workflowRevision: 7 } } }));
    act(() => result.current.dispatch({ type: "BIND_LEADER", cardId: "work-1", leaderNodeId: "node-2" }));
    const failedBinding = send.mock.calls.map(([command]) => command as {
      type: string; requestId: string; bindingId?: string })
      .find((command) => command.type === "attach_work_item_surface"
        && command.bindingId === "node-2")!;
    act(() => listener?.({ type: "work_item_response", command: "attach_work_item_surface",
      requestId: failedBinding.requestId, success: false, error: "conflict" }));
    expect(send.mock.calls.filter(([command]) => command.type === "update_work_item_card"
      && command.cardPatch?.leaderNodeId === "node-2")).toHaveLength(0);
    const completionUpdate = send.mock.calls
      .map(([command]) => command as { type: string; requestId: string; cardPatch?: { agentSummary?: string } })
      .find((command) => command.type === "update_work_item_card"
        && command.cardPatch?.agentSummary === "Shipped")!;
    const movesBeforeSuccess = send.mock.calls.filter(([command]) =>
      command.type === "move_work_item_card").length;
    expect(movesBeforeSuccess).toBe(1);
    expect(send.mock.calls.filter(([command]) => command.type === "move_work_item_card"
      && command.columnId === "history")).toHaveLength(0);
    act(() => listener?.({ type: "work_item_response", command: "update_work_item_card",
      requestId: completionUpdate.requestId, success: true,
      result: { workItem: { ...item(), workflowRevision: 7 } } }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "move_work_item_card",
      expectedWorkflowRevision: 7, columnId: "history" }));
    act(() => result.current.dispatch({ type: "COMPLETE_CARD", cardId: "work-1",
      summary: "Will fail" }));
    const failedUpdate = send.mock.calls.map(([command]) => command as {
      type: string; requestId: string; cardPatch?: { agentSummary?: string } })
      .find((command) => command.type === "update_work_item_card"
        && command.cardPatch?.agentSummary === "Will fail")!;
    const movesBeforeFailure = send.mock.calls.filter(([command]) =>
      command.type === "move_work_item_card").length;
    act(() => listener?.({ type: "work_item_response", command: "update_work_item_card",
      requestId: failedUpdate.requestId, success: false, error: "conflict" }));
    expect(send.mock.calls.filter(([command]) => command.type === "move_work_item_card"))
      .toHaveLength(movesBeforeFailure);
    const beforeProjection = send.mock.calls.length;
    act(() => result.current.dispatch({ type: "BLOCK_CARD", cardId: "work-1",
      reason: "needs_input" }));
    expect(send).toHaveBeenCalledTimes(beforeProjection);
    act(() => result.current.dispatch({ type: "REMOVE_CARD", cardId: "work-1" }));
    act(() => result.current.dispatch({ type: "CLEAR_ARCHIVE" }));
    expect(send.mock.calls.filter(([command]) => command.type === "archive_work_item")).toHaveLength(1);
  });

  it("reviews terminal-open cards on Approve & Close but skips invalid review states", () => {
    const send = vi.fn(); const subscribe = (() => () => {}) as unknown as SocketSubscribe;
    const open: WorkItemSnapshot = { ...item(), lifecycle: { ...item().lifecycle,
      runtimeState: "inactive", outcome: "completed", resolution: "open", lifecycleRevision: 4 } };
    const { result, rerender } = renderHook(({ candidate }: { candidate: WorkItemSnapshot }) =>
      useServerKanban({ projectId: "project-1", projectPath: "/repo", connected: false,
        items: [candidate], send, subscribe }), { initialProps: { candidate: open } });
    act(() => result.current.dispatch({ type: "COMPLETE_CARD", cardId: "work-1" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "review_work_item",
      workItemId: "work-1", expectedLifecycleRevision: 4, expectedCurrentRunKey: null }));
    const reviewed: WorkItemSnapshot = { ...open,
      lifecycle: { ...open.lifecycle, resolution: "reviewed", lifecycleRevision: 5 } };
    rerender({ candidate: reviewed });
    act(() => result.current.dispatch({ type: "COMPLETE_CARD", cardId: "work-1" }));
    const activeTerminal: WorkItemSnapshot = { ...open,
      lifecycle: { ...open.lifecycle, runtimeState: "working" } };
    rerender({ candidate: activeTerminal });
    act(() => result.current.dispatch({ type: "COMPLETE_CARD", cardId: "work-1" }));
    expect(send.mock.calls.filter(([command]) => command.type === "review_work_item")).toHaveLength(1);
  });

  it("attaches a replacement binding before detaching the prior canvas node", () => {
    const send = vi.fn(); let listener: ((message: ServerMessage) => void) | undefined;
    const subscribe = ((_: string, fn: (message: ServerMessage) => void) => {
      listener = fn; return () => {};
    }) as SocketSubscribe;
    const bound: WorkItemSnapshot = { ...item(),
      card: { ...item().card, leaderNodeId: "node-old" } };
    const { result } = renderHook(() => useServerKanban({ projectId: "project-1",
      projectPath: "/repo", connected: false, items: [bound], send, subscribe }));
    act(() => result.current.dispatch({ type: "BIND_LEADER", cardId: "work-1",
      leaderNodeId: "node-new" }));
    const attach = send.mock.calls[0]?.[0] as { requestId: string };
    expect(attach).toMatchObject({ type: "attach_work_item_surface", bindingId: "node-new" });
    act(() => listener?.({ type: "work_item_response", command: "attach_work_item_surface",
      requestId: attach.requestId, success: true,
      result: { workItem: { ...bound, workflowRevision: 3 } } }));
    const update = send.mock.calls[1]?.[0] as { requestId: string };
    expect(update).toMatchObject({ type: "update_work_item_card",
      cardPatch: { leaderNodeId: "node-new" } });
    expect(send.mock.calls.filter(([command]) => command.type === "detach_work_item_surface"))
      .toHaveLength(0);
    act(() => listener?.({ type: "work_item_response", command: "update_work_item_card",
      requestId: update.requestId, success: true, result: { workItem: bound } }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "detach_work_item_surface",
      bindingId: "node-old", expectedLifecycleRevision: bound.lifecycle.lifecycleRevision }));
    act(() => result.current.dispatch({ type: "BIND_LEADER", cardId: "work-1",
      leaderNodeId: "node-bad" }));
    const failedAttach = send.mock.calls.map(([command]) => command as {
      type: string; requestId: string; bindingId?: string })
      .find((command) => command.type === "attach_work_item_surface"
        && command.bindingId === "node-bad")!;
    act(() => listener?.({ type: "work_item_response", command: "attach_work_item_surface",
      requestId: failedAttach.requestId, success: true, result: { workItem: bound } }));
    const failedUpdate = send.mock.calls.map(([command]) => command as {
      type: string; requestId: string; cardPatch?: { leaderNodeId?: string } })
      .find((command) => command.type === "update_work_item_card"
        && command.cardPatch?.leaderNodeId === "node-bad")!;
    const latest = { ...bound, lifecycle: { ...bound.lifecycle, lifecycleRevision: 9 } };
    act(() => listener?.({ type: "work_item_response", command: "update_work_item_card",
      requestId: failedUpdate.requestId, success: false, error: "workflow conflict",
      latest: { workItem: latest } }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "detach_work_item_surface",
      bindingId: "node-bad", expectedLifecycleRevision: 9 }));
  });

  it("archives only inactive history and never active or already-archived cards", () => {
    const send = vi.fn(); const subscribe = (() => () => {}) as unknown as SocketSubscribe;
    const inactive: WorkItemSnapshot = { ...item(), lifecycle: { ...item().lifecycle,
      runtimeState: "inactive", outcome: "completed", resolution: "reviewed", lifecycleRevision: 4 } };
    const { result, rerender } = renderHook(({ candidate }: { candidate: WorkItemSnapshot }) =>
      useServerKanban({ projectId: "project-1", projectPath: "/repo", connected: false,
        items: [candidate], send, subscribe }), { initialProps: { candidate: inactive } });
    act(() => result.current.dispatch({ type: "CLEAR_ARCHIVE" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "archive_work_item",
      expectedLifecycleRevision: 4 }));
    const active: WorkItemSnapshot = { ...item(), lifecycle: { ...item().lifecycle,
      runtimeState: "working" } };
    rerender({ candidate: active });
    act(() => result.current.dispatch({ type: "REMOVE_CARD", cardId: "work-1" }));
    const archived: WorkItemSnapshot = { ...inactive,
      lifecycle: { ...inactive.lifecycle, resolution: "archived", lifecycleRevision: 5 } };
    rerender({ candidate: archived });
    act(() => result.current.dispatch({ type: "REMOVE_CARD", cardId: "work-1" }));
    expect(send.mock.calls.filter(([command]) => command.type === "archive_work_item")).toHaveLength(1);
  });
});
