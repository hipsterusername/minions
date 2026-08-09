import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { WorkItemDetailSnapshot, WorkItemListSnapshot, WorkItemRunSnapshot,
  WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import { selectWorkItemPresentation } from "../shared/work-item-lifecycle.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";
import { mergeWorkItemSnapshot } from "./work-item-snapshot-merge.ts";
import { randomUuid } from "./random-id.ts";
import { formatCoordinatedLabel, reduceLiveEditAwareness,
  type LiveEditAwareness } from "../shared/live-edit-coordination.ts";
import { decideConflictRecovery } from "./work-item-retry-policy.ts";
export { mergeWorkItemSnapshot } from "./work-item-snapshot-merge.ts";

export interface WorkItemClientState {
  projectId: string | null;
  items: Record<string, WorkItemSnapshot>;
  runs: Record<string, WorkItemRunSnapshot[]>;
  runNextCursor: Record<string, string | null>;
  coordination: Record<string, LiveEditAwareness>;
}

export const initialWorkItemClientState: WorkItemClientState = { projectId: null, items: {}, runs: {}, runNextCursor: {}, coordination: {} };

type WorkItemClientAction = ServerMessage | {
  type: "work_item_list_page";
  result: WorkItemListSnapshot;
  replace: boolean;
};

export function mergeWorkItemListPage(
  state: WorkItemClientState,
  result: WorkItemListSnapshot,
  replace: boolean,
): WorkItemClientState {
  const items: Record<string, WorkItemSnapshot> = replace ? {} : { ...state.items };
  for (const item of result.items) {
    const prior = items[item.id];
    items[item.id] = prior ? mergeWorkItemSnapshot(prior, item) : item;
  }
  const ids = new Set(Object.keys(items));
  const coordination = {
    ...Object.fromEntries(Object.entries(state.coordination)
      .filter(([workItemId]) => ids.has(workItemId))),
    ...(result.coordination ?? {}),
  };
  return { ...state, projectId: result.projectId, items, coordination };
}

function mergeRunSnapshots(
  current: readonly WorkItemRunSnapshot[],
  incoming: readonly WorkItemRunSnapshot[],
): WorkItemRunSnapshot[] {
  return [...new Map([...current, ...incoming].map((run) => [run.runKey, run])).values()]
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function reduceWorkItems(state: WorkItemClientState, msg: WorkItemClientAction): WorkItemClientState {
  if (msg.type === "work_item_list_page") {
    return mergeWorkItemListPage(state, msg.result, msg.replace);
  }
  if (msg.type === "live_edit_coordination") return { ...state, coordination: {
    ...state.coordination, [msg.workItemId]: reduceLiveEditAwareness(
      state.coordination[msg.workItemId], msg.event) } };
  if (msg.type === "work_item_response" && msg.success && msg.command === "list_work_items") {
    const result = msg.result as WorkItemListSnapshot;
    if (!result?.items) return state;
    return mergeWorkItemListPage(state, result, true);
  }
  if (msg.type === "work_item_response" && msg.success
    && (msg.result as Partial<WorkItemDetailSnapshot> | undefined)?.workItem?.id) {
    const detail = msg.result as WorkItemDetailSnapshot;
    const workItem = detail.workItem;
    if (workItem.projectId !== state.projectId) return state;
    const prior = state.items[workItem.id];
    const merged = prior ? mergeWorkItemSnapshot(prior, workItem) : workItem;
    const detailRuns = [
      ...(detail.runs ?? []),
      ...(detail.currentRun ? [detail.currentRun] : []),
    ];
    const runs = detailRuns.length === 0 ? state.runs : {
      ...state.runs,
      [workItem.id]: mergeRunSnapshots(state.runs[workItem.id] ?? [], detailRuns),
    };
    return { ...state, items: { ...state.items, [workItem.id]: merged }, runs };
  }
  if (msg.type === "work_item_changed" || msg.type === "work_item_created") {
    const prior = state.items[msg.workItem.id];
    if (!prior) return { ...state, items: { ...state.items, [msg.workItem.id]: msg.workItem } };
    const merged = mergeWorkItemSnapshot(prior, msg.workItem);
    if (merged === prior) return state;
    return { ...state, items: { ...state.items, [msg.workItem.id]: merged } };
  }
  if (msg.type === "work_item_response" && !msg.success) {
    // A failed mutation carries the authoritative snapshot in `latest`.
    // Fold it in so the store self-heals from stale revision fences and the
    // user's next click carries fences the server will accept.
    const latest = (msg as { latest?: { workItem?: WorkItemSnapshot } | null }).latest;
    const workItem = latest?.workItem;
    if (!workItem?.id) return state;
    const prior = state.items[workItem.id];
    if (!prior) return state; // only heal items this project's store already tracks
    const merged = mergeWorkItemSnapshot(prior, workItem);
    if (merged === prior) return state;
    return { ...state, items: { ...state.items, [workItem.id]: merged } };
  }
  if (msg.type === "work_item_run_created" || msg.type === "work_item_run_sealed") {
    const prior = state.runs[msg.workItemId] ?? [];
    const runs = mergeRunSnapshots(prior, [msg.run]);
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
      canonicalWorkItem: true,
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
  // The session list and canonical work-item list hydrate independently. Until
  // the latter arrives, every persisted iteration is present as its own raw
  // session row. Keep one representative row per durable work item so Activity
  // never temporarily re-roots the user's intention at each run key. The
  // canonical snapshot replaces this representative as soon as it is known.
  const linkedFallback = new Map<string, MobileSessionInfo>();
  const legacyFallback: MobileSessionInfo[] = [];
  const representativeRank = (session: MobileSessionInfo) =>
    session.runKind === "primary" ? 2 : session.role === "leader" ? 1 : 0;
  for (const session of sessions) {
    if (!session.workItemId) {
      legacyFallback.push(session);
      continue;
    }
    if (canonicalIds.has(session.workItemId)) continue;
    const prior = linkedFallback.get(session.workItemId);
    if (!prior || representativeRank(session) > representativeRank(prior)
      || (representativeRank(session) === representativeRank(prior)
        && (session.lastActivityAt ?? 0) >= (prior.lastActivityAt ?? 0))) {
      linkedFallback.set(session.workItemId, session);
    }
  }
  return [...canonical, ...linkedFallback.values(), ...legacyFallback];
}

/** Stable Activity identity: work-item entries survive currentRunKey changes. */
export function activityEntryId(session: Pick<MobileSessionInfo, "sessionKey" | "workItemId">): string {
  return session.workItemId ? `work-item:${session.workItemId}` : `session:${session.sessionKey}`;
}

export interface PromptFailure {
  prompt: string;
  error: string;
}

export function useWorkItems(input: {
  projectId: string | null; connected: boolean; subscribe: SocketSubscribe; send: (data: unknown) => void;
}) {
  const [state, dispatch] = useReducer(reduceWorkItems, initialWorkItemClientState);
  const [promptFailures, setPromptFailures] = useState<Record<string, PromptFailure>>({});
  const listRequests = useRef(new Map<string, { projectId: string; replace: boolean }>());
  const pendingPrompts = useRef(new Map<string, {
    prompt: string; attempts: number; projectId: string; workItemId: string;
  }>());
  const requestListPage = useCallback((projectId: string, cursor?: string, replace = false) => {
    const requestId = randomUuid();
    listRequests.current.set(requestId, { projectId, replace });
    input.send({
      type: "list_work_items",
      requestId,
      projectId,
      includeArchived: true,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
  }, [input.send]);
  const clearPromptFailure = useCallback((workItemId: string) => {
    setPromptFailures((current) => {
      if (!(workItemId in current)) return current;
      const next = { ...current };
      delete next[workItemId];
      return next;
    });
  }, []);
  const receive = useCallback((message: ServerMessage) => {
    if ((message.type === "work_item_changed" || message.type === "work_item_created")
      && message.workItem.projectId !== input.projectId) return;
    if (message.type === "work_item_response" && message.success
      && message.command === "list_work_items") {
      const result = message.result as Partial<WorkItemListSnapshot> | undefined;
      if (result?.projectId !== input.projectId) return;
      const requestId = message.requestId;
      const request = requestId ? listRequests.current.get(requestId) : undefined;
      if (requestId) {
        // Ignore a page from an obsolete refresh generation (for example,
        // after a reconnect or project switch) instead of replacing the
        // current aggregate with that one stale page.
        if (!request || !result.items) return;
        listRequests.current.delete(requestId);
        if (request.projectId !== input.projectId) return;
        dispatch({
          type: "work_item_list_page",
          result: result as WorkItemListSnapshot,
          replace: request.replace,
        });
        if (result.nextCursor) requestListPage(request.projectId, result.nextCursor);
        return;
      }
    }
    dispatch(message);
    if (message.type !== "work_item_response" || !message.requestId) return;
    const pending = pendingPrompts.current.get(message.requestId);
    if (!pending) return;
    pendingPrompts.current.delete(message.requestId);
    if (message.success) return;
    const recovery = decideConflictRecovery({
      code: message.code,
      latest: message.latest as WorkItemDetailSnapshot | null | undefined,
      attempt: pending.attempts,
      projectId: input.projectId,
      workItemId: pending.workItemId,
      prompt: pending.prompt,
      requestId: randomUuid(),
    });
    if (recovery.kind === "retry") {
      pendingPrompts.current.set(recovery.command.requestId, {
        ...pending, attempts: pending.attempts + 1,
      });
      input.send({ ...recovery.command, displayPrompt: pending.prompt });
      return;
    }
    if (recovery.kind === "give-up" && pending.projectId === input.projectId) {
      setPromptFailures((current) => ({
        ...current,
        [pending.workItemId]: {
          prompt: pending.prompt,
          error: message.error ?? "Work-item command failed",
        },
      }));
    }
  }, [input.projectId, input.send, requestListPage]);
  useEffect(() => input.subscribe("*", receive), [input.subscribe, receive]);
  useEffect(() => input.projectId
    ? input.subscribe(`project:${input.projectId}`, receive)
    : undefined, [input.projectId, input.subscribe, receive]);
  useEffect(() => {
    listRequests.current.clear();
    pendingPrompts.current.clear();
    setPromptFailures({});
    return () => {
      listRequests.current.clear();
      pendingPrompts.current.clear();
    };
  }, [input.connected, input.projectId]);
  useEffect(() => {
    if (input.connected && input.projectId) requestListPage(input.projectId, undefined, true);
  }, [input.connected, input.projectId, requestListPage]);
  const mutate = useCallback((type: string, item: WorkItemSnapshot,
    extra: Record<string, unknown> = {}) => {
    const requestId = randomUuid();
    if (type === "continue_work_item" && typeof extra["prompt"] === "string") {
      clearPromptFailure(item.id);
      pendingPrompts.current.set(requestId, {
        prompt: extra["prompt"], attempts: 1,
        projectId: item.projectId, workItemId: item.id,
      });
    }
    input.send({ type, requestId, workItemId: item.id,
      expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: item.currentRunKey, ...extra,
      ...(type === "continue_work_item" && typeof extra["prompt"] === "string"
        ? { displayPrompt: extra["prompt"] }
        : {}),
    });
  }, [clearPromptFailure, input.send]);
  return useMemo(() => ({ ...state,
    promptFailures, clearPromptFailure,
    orderedItems: state.projectId === input.projectId
      ? Object.values(state.items).sort((a, b) => b.updatedAt - a.updatedAt) : [],
    loadRuns: (workItemId: string, cursor?: string) => input.send({
      type: "get_work_item_runs", workItemId, cursor, limit: 100,
    }),
    review: (item: WorkItemSnapshot) => mutate("review_work_item", item),
    archive: (item: WorkItemSnapshot) => mutate("archive_work_item", item),
    restore: (item: WorkItemSnapshot) => mutate("restore_work_item", item),
    start: (item: WorkItemSnapshot, prompt: string) => mutate("continue_work_item", item, { prompt }),
    reply: (item: WorkItemSnapshot, prompt: string) => mutate("continue_work_item", item, { prompt }),
  }), [state, promptFailures, clearPromptFailure, input.projectId, input.send, mutate]);
}
