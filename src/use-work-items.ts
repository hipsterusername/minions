import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { WorkItemListSnapshot, WorkItemRunSnapshot, WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import { selectWorkItemPresentation } from "../shared/work-item-lifecycle.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";
import { mergeWorkItemSnapshot } from "./work-item-snapshot-merge.ts";
import { formatCoordinatedLabel, reduceLiveEditAwareness,
  type LiveEditAwareness } from "../shared/live-edit-coordination.ts";
export { mergeWorkItemSnapshot } from "./work-item-snapshot-merge.ts";

export interface WorkItemClientState {
  projectId: string | null;
  items: Record<string, WorkItemSnapshot>;
  runs: Record<string, WorkItemRunSnapshot[]>;
  runNextCursor: Record<string, string | null>;
  coordination: Record<string, LiveEditAwareness>;
}

export const initialWorkItemClientState: WorkItemClientState = { projectId: null, items: {}, runs: {}, runNextCursor: {}, coordination: {} };

export function reduceWorkItems(state: WorkItemClientState, msg: ServerMessage): WorkItemClientState {
  if (msg.type === "live_edit_coordination") return { ...state, coordination: {
    ...state.coordination, [msg.workItemId]: reduceLiveEditAwareness(
      state.coordination[msg.workItemId], msg.event) } };
  if (msg.type === "work_item_response" && msg.success && msg.command === "list_work_items") {
    const result = msg.result as WorkItemListSnapshot;
    if (!result?.items) return state;
    const items = Object.fromEntries(result.items.map((item) => [item.id, item]));
    const ids = new Set(result.items.map((item) => item.id));
    const coordination = result.coordination ?? Object.fromEntries(Object.entries(state.coordination)
      .filter(([workItemId]) => ids.has(workItemId)));
    return { ...state, projectId: result.projectId, items, coordination };
  }
  if (msg.type === "work_item_changed" || msg.type === "work_item_created") {
    const prior = state.items[msg.workItem.id];
    if (!prior) return { ...state, items: { ...state.items, [msg.workItem.id]: msg.workItem } };
    const merged = mergeWorkItemSnapshot(prior, msg.workItem);
    if (merged === prior) return state;
    return { ...state, items: { ...state.items, [msg.workItem.id]: merged } };
  }
  if (msg.type === "work_item_run_created" || msg.type === "work_item_run_sealed") {
    const prior = state.runs[msg.workItemId] ?? [];
    const runs = [...prior.filter((run) => run.runKey !== msg.run.runKey), msg.run]
      .sort((a, b) => b.startedAt - a.startedAt);
    return { ...state, runs: { ...state.runs, [msg.workItemId]: runs } };
  }
  if (msg.type === "work_item_response" && msg.success && msg.command === "get_work_item_runs") {
    const result = msg.result as { workItemId?: string; runs?: WorkItemRunSnapshot[]; nextCursor?: string | null };
    if (!result?.workItemId || !result.runs) return state;
    const prior = state.runs[result.workItemId] ?? [];
    const page = [...prior, ...result.runs];
    const immutableHistory = [...new Map(page.map((run) => [run.runKey, run])).values()]
      .sort((a, b) => b.startedAt - a.startedAt);
    return { ...state, runs: { ...state.runs, [result.workItemId]: immutableHistory },
      runNextCursor: { ...state.runNextCursor, [result.workItemId]: result.nextCursor ?? null } };
  }
  return state;
}

export function mergeCanonicalActivity(
  sessions: readonly MobileSessionInfo[], items: readonly WorkItemSnapshot[],
  coordination: Readonly<Record<string, LiveEditAwareness>> = {},
): MobileSessionInfo[] {
  const canonicalIds = new Set(items.map((item) => item.id));
  const byRun = new Map(sessions.map((session) => [session.sessionKey, session]));
  const canonical = items.map((item): MobileSessionInfo => {
    const base = item.currentRunKey ? byRun.get(item.currentRunKey) : undefined;
    const presentation = selectWorkItemPresentation(item.lifecycle, { waitKind: item.waitKind });
    const liveEditAwareness = coordination[item.id];
    return {
      ...(base ?? {}),
      sessionKey: item.currentRunKey ?? `work-item:${item.id}`,
      sessionId: base?.sessionId ?? null,
      workItemId: item.id,
      status: item.lifecycle.runtimeState === "working" ? "running" : item.lifecycle.runtimeState,
      cwd: item.projectPath,
      role: "leader",
      taskName: item.title,
      lastActivityAt: item.updatedAt,
      lastActivity: formatCoordinatedLabel(presentation.label, liveEditAwareness),
      ...(liveEditAwareness ? { liveEditAwareness } : {}),
      pendingAttention: presentation.needsAttention,
      reviewLifecycle: {
        reviewState: item.lifecycle.runtimeState === "waiting" && item.waitKind === "decision" ? "decision_needed"
          : item.lifecycle.outcome === "completed" ? "completion_to_review"
          : item.lifecycle.outcome === "error" ? "error_to_review"
          : item.lifecycle.outcome === "interrupted" ? "interrupted_to_review" : "none",
        reviewReason: presentation.label, finalReport: base?.reviewLifecycle?.finalReport ?? null,
        finalDashboardRevision: base?.reviewLifecycle?.finalDashboardRevision ?? null,
        dashboardRevision: base?.reviewLifecycle?.dashboardRevision ?? 0,
        terminalReason: base?.reviewLifecycle?.terminalReason ?? null,
        terminalAt: item.lifecycle.outcome === "none" ? null : item.lastTransitionAt,
        acknowledgedAt: item.lifecycle.resolution === "reviewed" ? item.lastTransitionAt : null,
        dismissedAt: item.lifecycle.resolution === "archived" ? item.lastTransitionAt : null,
        lifecycleRevision: item.lifecycle.lifecycleRevision,
      },
    };
  });
  const fallback = sessions.filter((session) => !session.workItemId || !canonicalIds.has(session.workItemId));
  return [...canonical, ...fallback];
}

export function useWorkItems(input: {
  projectId: string | null; connected: boolean; subscribe: SocketSubscribe; send: (data: unknown) => void;
}) {
  const [state, dispatch] = useReducer(reduceWorkItems, initialWorkItemClientState);
  const receive = useCallback((message: ServerMessage) => {
    if ((message.type === "work_item_changed" || message.type === "work_item_created")
      && message.workItem.projectId !== input.projectId) return;
    if (message.type === "work_item_response" && message.success
      && message.command === "list_work_items") {
      const result = message.result as Partial<WorkItemListSnapshot> | undefined;
      if (result?.projectId !== input.projectId) return;
    }
    dispatch(message);
  }, [input.projectId]);
  useEffect(() => input.subscribe("*", receive), [input.subscribe, receive]);
  useEffect(() => input.projectId
    ? input.subscribe(`project:${input.projectId}`, receive)
    : undefined, [input.projectId, input.subscribe, receive]);
  useEffect(() => {
    if (input.connected && input.projectId) input.send({ type: "list_work_items", projectId: input.projectId, includeArchived: true });
  }, [input.connected, input.projectId, input.send]);
  const mutate = useCallback((type: string, item: WorkItemSnapshot, extra: Record<string, unknown> = {}) =>
    input.send({ type, requestId: crypto.randomUUID(), workItemId: item.id,
      expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: item.currentRunKey, ...extra }), [input.send]);
  return useMemo(() => ({ ...state,
    orderedItems: state.projectId === input.projectId
      ? Object.values(state.items).sort((a, b) => b.updatedAt - a.updatedAt) : [],
    loadRuns: (item: WorkItemSnapshot, cursor?: string) => input.send({ type: "get_work_item_runs", workItemId: item.id, cursor, limit: 25 }),
    review: (item: WorkItemSnapshot) => mutate("review_work_item", item),
    archive: (item: WorkItemSnapshot) => mutate("archive_work_item", item),
    restore: (item: WorkItemSnapshot) => mutate("restore_work_item", item),
    start: (item: WorkItemSnapshot, prompt: string) => mutate("start_work_item_run", item, { prompt }),
    reply: (item: WorkItemSnapshot, prompt: string) => mutate("reply_to_waiting_run", item, { runKey: item.currentRunKey, prompt }),
  }), [state, input.send, mutate]);
}
