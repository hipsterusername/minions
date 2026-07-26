import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import type { KanbanImportCard } from "../shared/work-item-kanban.ts";
import { DEFAULT_COLUMNS, type KanbanAction, type KanbanBoard, type KanbanCard } from "./kanban-types.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";
import { randomUuid } from "./random-id.ts";

const STORAGE_PREFIX = "kanban-";
const MIGRATION_PREFIX = "kanban-server-migrated-";
const MIGRATION_KEY = "local-storage-v1";

export function projectWorkItemsToKanban(items: readonly WorkItemSnapshot[]): KanbanBoard {
  return { columns: DEFAULT_COLUMNS, cards: items.filter((item) => item.lifecycle.resolution !== "archived")
    .sort((a, b) => a.workflowColumnId.localeCompare(b.workflowColumnId)
      || a.workflowRank.localeCompare(b.workflowRank)).map((item): KanbanCard => {
      const { leaderNodeId, ...card } = item.card;
      return { id: item.id, title: item.title, columnId: item.workflowColumnId,
        createdAt: item.createdAt, ...card,
        ...(leaderNodeId ? { leaderNodeId } : {}),
        permissionMode: item.card.permissionMode as KanbanCard["permissionMode"] };
    }) };
}

export function boardToKanbanImport(board: KanbanBoard,
  existingByLeaderNodeId: ReadonlyMap<string, string> = new Map()): KanbanImportCard[] {
  const columnPosition = new Map<string, number>();
  return board.cards.map((card) => {
    const position = columnPosition.get(card.columnId) ?? 0;
    columnPosition.set(card.columnId, position + 1);
    const { archivedMessages: _messages, archivedTaskPlan: _plan,
      archivedTaskName: _taskName, archivedTurns: _turns,
      blockReason: legacyBlockReason, ...metadata } = card;
    const blockReason = legacyBlockReason === "idle_review" ? undefined : legacyBlockReason;
    return { ...metadata, ...(blockReason ? { blockReason } : {}),
      rank: String(position).padStart(8, "0"),
      ...(card.leaderNodeId && existingByLeaderNodeId.get(card.leaderNodeId)
        ? { existingWorkItemId: existingByLeaderNodeId.get(card.leaderNodeId)! } : {}) };
  });
}

export function readLegacyKanbanBoard(projectId: string): KanbanBoard | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KanbanBoard>;
    return Array.isArray(parsed.columns) && Array.isArray(parsed.cards)
      ? parsed as KanbanBoard : null;
  } catch { return null; }
}

export function useServerKanban(input: {
  projectId: string; projectPath: string; connected: boolean;
  items: readonly WorkItemSnapshot[]; send: (data: unknown) => void;
  subscribe: SocketSubscribe;
  existingByLeaderNodeId?: ReadonlyMap<string, string>;
}) {
  const pendingImport = useRef<{ projectId: string; requestId: string } | null>(null);
  const pendingCompletion = useRef(new Map<string, string>());
  const pendingBindingUpdate = useRef(new Map<string, {
    workItemId: string; bindingId: string; priorBindingId?: string;
    lifecycleRevision: number; currentRunKey: string | null }>());
  const pendingBindingAttach = useRef(new Map<string, {
    workItemId: string; bindingId: string; priorBindingId?: string }>());
  useEffect(() => input.subscribe("*", (message: ServerMessage) => {
    if (message.type === "work_item_response" && message.command === "import_kanban_board"
      && message.requestId === pendingImport.current?.requestId
      && pendingImport.current.projectId === input.projectId) {
      if (message.success) localStorage.setItem(`${MIGRATION_PREFIX}${input.projectId}`, MIGRATION_KEY);
      pendingImport.current = null;
    }
    if (message.type === "work_item_response" && message.command === "attach_work_item_surface"
      && message.requestId && pendingBindingAttach.current.has(message.requestId)) {
      const binding = pendingBindingAttach.current.get(message.requestId)!;
      pendingBindingAttach.current.delete(message.requestId);
      const attached = message.result as { workItem?: WorkItemSnapshot } | undefined;
      if (message.success && attached?.workItem?.id === binding.workItemId) {
        const updateRequestId = randomUuid();
        pendingBindingUpdate.current.set(updateRequestId, { ...binding,
          lifecycleRevision: attached.workItem.lifecycle.lifecycleRevision,
          currentRunKey: attached.workItem.currentRunKey });
        input.send({ type: "update_work_item_card", requestId: updateRequestId,
          workItemId: binding.workItemId,
          expectedWorkflowRevision: attached.workItem.workflowRevision,
          cardPatch: { leaderNodeId: binding.bindingId } });
      }
    }
    if (message.type !== "work_item_response" || message.command !== "update_work_item_card"
      || !message.requestId) return;
    const result = message.result as { workItem?: WorkItemSnapshot } | undefined;
    const completionId = pendingCompletion.current.get(message.requestId);
    if (completionId) {
      pendingCompletion.current.delete(message.requestId);
      if (message.success && result?.workItem?.id === completionId)
        input.send({ type: "move_work_item_card", requestId: randomUuid(), workItemId: completionId,
          expectedWorkflowRevision: result.workItem.workflowRevision,
          columnId: "history", targetIndex: 0 });
    }
    const binding = pendingBindingUpdate.current.get(message.requestId);
    if (binding) {
      pendingBindingUpdate.current.delete(message.requestId);
      const latest = message.latest as { workItem?: WorkItemSnapshot } | undefined;
      if (!message.success) input.send({ type: "detach_work_item_surface",
        requestId: randomUuid(), workItemId: binding.workItemId,
        expectedLifecycleRevision: latest?.workItem?.lifecycle.lifecycleRevision
          ?? binding.lifecycleRevision,
        expectedCurrentRunKey: latest?.workItem
          ? latest.workItem.currentRunKey : binding.currentRunKey,
        surface: "canvas", bindingId: binding.bindingId });
      if (message.success && result?.workItem?.id === binding.workItemId
        && binding.priorBindingId && binding.priorBindingId !== binding.bindingId)
        input.send({ type: "detach_work_item_surface", requestId: randomUuid(),
          workItemId: binding.workItemId,
          expectedLifecycleRevision: result.workItem.lifecycle.lifecycleRevision,
          expectedCurrentRunKey: result.workItem.currentRunKey,
          surface: "canvas", bindingId: binding.priorBindingId });
    }
  }), [input.projectId, input.send, input.subscribe]);
  useEffect(() => {
    if (!input.connected || localStorage.getItem(`${MIGRATION_PREFIX}${input.projectId}`)) return;
    if (pendingImport.current?.projectId === input.projectId) return;
    const board = readLegacyKanbanBoard(input.projectId);
    if (!board?.cards.length) return;
    const requestId = randomUuid(); pendingImport.current = { projectId: input.projectId, requestId };
    input.send({ type: "import_kanban_board", requestId, projectId: input.projectId,
      projectPath: input.projectPath, migrationKey: MIGRATION_KEY,
      cards: boardToKanbanImport(board, input.existingByLeaderNodeId) });
  }, [input.connected, input.existingByLeaderNodeId, input.projectId, input.projectPath, input.send]);
  const projectItems = useMemo(() => input.items.filter((item) => item.projectId === input.projectId),
    [input.items, input.projectId]);
  const byId = useMemo(() => new Map(projectItems.map((item) => [item.id, item])), [projectItems]);
  const dispatch = useCallback((action: KanbanAction) => {
    if (action.type === "ADD_CARD") {
      const { id: _id, title, columnId, createdAt: _created, ...cardPatch } = action.card;
      input.send({ type: "create_work_item", requestId: randomUuid(),
        projectId: input.projectId, projectPath: input.projectPath, title,
        changeMode: action.card.worktreeIsolation ? "worktree" : "live",
        workflowColumnId: columnId, workflowRank: String(Date.now()), cardPatch }); return;
    }
    if (action.type === "REMOVE_CARD") {
      const item = byId.get(action.cardId);
      if (item && ["draft", "inactive"].includes(item.lifecycle.runtimeState)
        && item.lifecycle.resolution !== "archived")
        input.send({ type: "archive_work_item",
        requestId: randomUuid(), workItemId: item.id,
        expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
        expectedCurrentRunKey: item.currentRunKey }); return;
    }
    if (action.type === "CLEAR_ARCHIVE") {
      for (const item of projectItems.filter((entry) => entry.workflowColumnId === "history"
        && entry.lifecycle.runtimeState === "inactive" && entry.lifecycle.resolution !== "archived"))
        input.send({ type: "archive_work_item", requestId: randomUuid(), workItemId: item.id,
          expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
          expectedCurrentRunKey: item.currentRunKey }); return;
    }
    if (action.type === "TOGGLE_SUBTASK" || action.type === "ADD_SUBTASK"
      || action.type === "REMOVE_SUBTASK") {
      const item = byId.get(action.cardId); if (!item) return;
      const subtasks = action.type === "TOGGLE_SUBTASK"
        ? item.card.subtasks.map((task) => task.id === action.subtaskId ? { ...task, done: !task.done } : task)
        : action.type === "ADD_SUBTASK" ? [...item.card.subtasks, action.subtask]
          : item.card.subtasks.filter((task) => task.id !== action.subtaskId);
      input.send({ type: "update_work_item_card", requestId: randomUuid(),
        workItemId: item.id, expectedWorkflowRevision: item.workflowRevision,
        cardPatch: { subtasks } }); return;
    }
    if (action.type === "BIND_LEADER") {
      const item = byId.get(action.cardId); if (!item) return;
      const requestId = randomUuid(); pendingBindingAttach.current.set(requestId,
        { workItemId: item.id, bindingId: action.leaderNodeId,
          ...(item.card.leaderNodeId ? { priorBindingId: item.card.leaderNodeId } : {}) });
      input.send({ type: "attach_work_item_surface", requestId, workItemId: item.id,
        expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
        expectedCurrentRunKey: item.currentRunKey,
        surface: "canvas", bindingId: action.leaderNodeId }); return;
    }
    if (action.type === "COMPLETE_CARD") {
      const item = byId.get(action.cardId); if (!item) return;
      const requestId = randomUuid(); pendingCompletion.current.set(requestId, item.id);
      input.send({ type: "update_work_item_card", requestId,
        workItemId: item.id, expectedWorkflowRevision: item.workflowRevision,
        cardPatch: { ...(action.summary !== undefined ? { agentSummary: action.summary } : {}),
          ...(action.cost !== undefined ? { agentCost: action.cost } : {}) } });
      if (item.lifecycle.runtimeState === "inactive" && item.lifecycle.outcome !== "none"
        && item.lifecycle.resolution === "open")
        input.send({ type: "review_work_item", requestId: randomUuid(), workItemId: item.id,
          expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
          expectedCurrentRunKey: item.currentRunKey });
      return;
    }
    if (action.type === "BLOCK_CARD" || action.type === "UNBLOCK_CARD"
      || action.type === "HALT_CARD" || action.type === "RESUME_HALTED_CARD") return;
    if (action.type !== "UPDATE_CARD" && action.type !== "MOVE_CARD") return;
    const item = byId.get(action.cardId); if (!item) return;
    const requestId = randomUuid();
    if (action.type === "MOVE_CARD") input.send({ type: "move_work_item_card", requestId,
      workItemId: item.id, expectedWorkflowRevision: item.workflowRevision,
      columnId: action.targetColumnId, targetIndex: action.targetIndex ?? 0 });
    else { const { title, columnId: _column, createdAt: _created, ...cardPatch } = action.data;
      input.send({ type: "update_work_item_card", requestId, workItemId: item.id,
        expectedWorkflowRevision: item.workflowRevision, ...(title ? { title } : {}), cardPatch }); }
  }, [byId, input.projectId, input.projectPath, input.send, projectItems]);
  return useMemo(() => ({ board: projectWorkItemsToKanban(projectItems), dispatch }), [projectItems, dispatch]);
}
