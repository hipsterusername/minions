import { useTaskRetryReceipts } from "./use-task-retry-receipts.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  taskGraphChangedEnvelopeSchema,
  taskGraphSnapshotEnvelopeSchema,
  taskGraphViewControlCommandSchema,
  type TaskGraphSnapshotView,
  type TaskGraphViewControlCommand,
  type TaskGraphViewEnvelope,
} from "../../shared/task-graph-view-contracts.ts";
import {
  taskGraphPlanChangedEnvelopeSchema,
  taskGraphPlanSnapshotEnvelopeSchema,
  type TaskGraphPlanEnvelope,
  type TaskGraphPlanSnapshotView,
} from "../../shared/task-graph-planning-contracts.ts";
import { workItemTopic } from "../../shared/ws-envelope.ts";
import { randomUuid } from "../random-id.ts";
import { subscribeSocketTopic, type SocketSubscribeLike } from "../use-socket.ts";
import type { GraphInspectorAction } from "./types.ts";

export interface TaskGraphFoldState {
  workItemId: string;
  snapshot: TaskGraphSnapshotView | null;
}

export interface TaskGraphFoldResult extends TaskGraphFoldState {
  refetch: boolean;
}

export interface TaskGraphPlanFoldState {
  workItemId: string;
  snapshot: TaskGraphPlanSnapshotView | null;
}

export function foldTaskGraphPlan(
  state: TaskGraphPlanFoldState,
  envelope: TaskGraphPlanEnvelope,
): TaskGraphPlanFoldState & { refetch: boolean } {
  if (envelope.workItemId !== state.workItemId) return { ...state, refetch: false };
  if (envelope.type === "task_graph_plan_snapshot") {
    if (state.snapshot && envelope.snapshot
      && envelope.snapshot.revision < state.snapshot.revision) return { ...state, refetch: false };
    return { ...state, snapshot: envelope.snapshot, refetch: false };
  }
  if (!state.snapshot) return { ...state, refetch: true };
  if (envelope.revision <= state.snapshot.revision) return { ...state, refetch: false };
  if (envelope.revision !== state.snapshot.revision + 1) return { ...state, refetch: true };
  return { ...state, snapshot: envelope.snapshot, refetch: false };
}

/**
 * Fold full canonical view messages without ever inventing missing revisions.
 * Incremental change events must be adjacent; a canonical snapshot may jump
 * revisions because it is the refetch response that repairs such a gap.
 */
export function foldTaskGraphView(
  state: TaskGraphFoldState,
  envelope: TaskGraphViewEnvelope,
): TaskGraphFoldResult {
  if (envelope.workItemId !== state.workItemId) return { ...state, refetch: false };
  const current = state.snapshot;

  if (envelope.type === "task_graph_snapshot") {
    const incoming = envelope.snapshot;
    if (current && incoming.graphRunId === current.graphRunId && incoming.revision < current.revision) {
      return { ...state, refetch: false };
    }
    return { ...state, snapshot: incoming, refetch: false };
  }

  if (!current || envelope.runId !== current.graphRunId) {
    return { ...state, refetch: true };
  }
  if (envelope.revision <= current.revision) return { ...state, refetch: false };
  if (envelope.revision !== current.revision + 1) return { ...state, refetch: true };
  const changes = envelope.changes;
  return { ...state, snapshot:{ ...current,revision:envelope.revision,status:changes.status,
    updatedAt:changes.updatedAt,nodes:mergeById(current.nodes,changes.nodes),
    edges:mergeById(current.edges,changes.edges),evidence:mergeById(current.evidence,changes.evidence),
    timeline:mergeById(current.timeline,changes.timeline),capacity:changes.capacity,budget:changes.budget,
    criticalPath:changes.criticalPath },refetch:false };
}

function mergeById<T extends {id:string}>(current: T[], changed: T[]): T[] {
  if (!changed.length) return current;
  const updates = new Map(changed.map(item => [item.id,item]));
  const merged = current.map(item => updates.get(item.id) ?? item);
  const known = new Set(current.map(item => item.id));
  return [...merged,...changed.filter(item => !known.has(item.id))];
}

export function graphActionToCommand(action: GraphInspectorAction, workItemId: string): TaskGraphViewControlCommand | null {
  const fence = {
    requestId: action.requestId,
    workItemId,
    runId: action.graphRunId,
    expectedRunRevision: action.expectedRunRevision,
  };
  let command: TaskGraphViewControlCommand | null;
  switch (action.type) {
    case "pause": command = { type: "pause_task_graph_run", ...fence }; break;
    case "resume": command = { type: "resume_task_graph_run", ...fence }; break;
    case "cancel_run": command = { type: "cancel_task_graph_run", ...fence }; break;
    case "retry": command = { type: "retry_task_node", ...fence,
      nodeId: action.nodeId!, currentAttemptId: action.currentAttemptId }; break;
    case "cancel_attempt":
      command = action.nodeId && action.currentAttemptId
        ? { type: "cancel_task_attempt", ...fence,
          nodeId: action.nodeId, currentAttemptId: action.currentAttemptId }
        : null;
      break;
    case "request_verification": command = { type: "request_task_verification", ...fence,
      nodeId: action.nodeId!, currentAttemptId: action.currentAttemptId }; break;
    case "waive_verification": command = { type: "waive_task_verification", ...fence,
      nodeId: action.nodeId!, currentAttemptId: action.currentAttemptId,actor:"operator",
      reason:action.reason }; break;
    case "adjudicate": command={type:"adjudicate_task_node",...fence,
      nodeId:action.nodeId!,currentAttemptId:action.currentAttemptId!,
      adjudication:action.decision,reason:action.reason,
      ...(action.guidance?{guidance:action.guidance}:{})};break;
    case "provide_input": command = { type: "provide_task_input", ...fence,
      nodeId: action.nodeId!, currentAttemptId: action.currentAttemptId,actor:"operator",input: action.input }; break;
  }
  if (!command) return null;
  const parsed = taskGraphViewControlCommandSchema.safeParse(command);
  return parsed.success ? parsed.data : null;
}

interface UseTaskGraphViewOptions {
  workItemId: string | null;
  send?: ((data: unknown) => void) | undefined;
  subscribe?: SocketSubscribeLike;
}

export function useTaskGraphView({ workItemId, send, subscribe }: UseTaskGraphViewOptions) {
  const [snapshot, setSnapshot] = useState<TaskGraphSnapshotView | null>(null);
  const [planSnapshot, setPlanSnapshot] = useState<TaskGraphPlanSnapshotView | null>(null);
  const [controlsEnabled, setControlsEnabled] = useState(false);
  const [planControlsEnabled, setPlanControlsEnabled] = useState(false);
  const stateRef = useRef<TaskGraphFoldState>({ workItemId: workItemId ?? "", snapshot: null });
  const planStateRef = useRef<TaskGraphPlanFoldState>({ workItemId: workItemId ?? "", snapshot: null });
  const refetchPendingRef = useRef(false);
  const planRefetchPendingRef = useRef(false);

  const refetch = useCallback(() => {
    if (!workItemId || !send || refetchPendingRef.current) return;
    refetchPendingRef.current = true;
    setControlsEnabled(false);
    send({ type: "get_task_graph_snapshot", requestId: randomUuid(), workItemId });
  }, [send, workItemId]);

  const refetchPlan = useCallback(() => {
    if (!workItemId || !send || planRefetchPendingRef.current) return;
    planRefetchPendingRef.current = true;
    send({ type: "get_task_graph_plan", requestId: randomUuid(), workItemId });
  }, [send, workItemId]);

  useEffect(() => {
    stateRef.current = { workItemId: workItemId ?? "", snapshot: null };
    planStateRef.current = { workItemId: workItemId ?? "", snapshot: null };
    refetchPendingRef.current = false;
    planRefetchPendingRef.current = false;
    setSnapshot(null);
    setPlanSnapshot(null);
    setControlsEnabled(false);
    setPlanControlsEnabled(false);
    if (!workItemId) return;

    const unsubscribe = subscribeSocketTopic(subscribe, workItemTopic(workItemId), (raw) => {
      if ((raw as { type?: unknown })?.type === "socket_reconnected") {
        setControlsEnabled(false);
        setPlanControlsEnabled(false);
        refetchPendingRef.current = false;
        planRefetchPendingRef.current = false;
        refetch();
        refetchPlan();
        return;
      }
      if ((raw as {type?:unknown;command?:unknown})?.type === "task_graph_response"
        && (raw as {command?:unknown}).command === "get_task_graph_snapshot") {
        refetchPendingRef.current=false;
        return;
      }
      const planSnapshotResult = taskGraphPlanSnapshotEnvelopeSchema.safeParse(raw);
      const planChangedResult = planSnapshotResult.success ? null
        : taskGraphPlanChangedEnvelopeSchema.safeParse(raw);
      const planEnvelope = planSnapshotResult.success ? planSnapshotResult.data
        : planChangedResult?.success ? planChangedResult.data : null;
      if (planEnvelope) {
        const previous = planStateRef.current.snapshot;
        const next = foldTaskGraphPlan(planStateRef.current, planEnvelope);
        planStateRef.current = { workItemId: next.workItemId, snapshot: next.snapshot };
        if (planEnvelope.type === "task_graph_plan_snapshot") {
          planRefetchPendingRef.current = false;
          setPlanControlsEnabled(true);
        }
        if (next.snapshot !== previous) setPlanSnapshot(next.snapshot);
        if (next.refetch) {
          setPlanControlsEnabled(false);
          refetchPlan();
        }
        return;
      }
      const snapshotResult = taskGraphSnapshotEnvelopeSchema.safeParse(raw);
      const changedResult = snapshotResult.success ? null : taskGraphChangedEnvelopeSchema.safeParse(raw);
      const envelope = snapshotResult.success ? snapshotResult.data
        : changedResult?.success ? changedResult.data : null;
      if (!envelope) return;

      const previous = stateRef.current.snapshot;
      const next = foldTaskGraphView(stateRef.current, envelope);
      stateRef.current = { workItemId: next.workItemId, snapshot: next.snapshot };
      if (envelope.type === "task_graph_snapshot" && next.snapshot === envelope.snapshot) {
        refetchPendingRef.current = false;
        setControlsEnabled(true);
      }
      if (next.snapshot !== previous) setSnapshot(next.snapshot);
      if (next.refetch) {
        setControlsEnabled(false);
        refetch();
      }
    });
    refetch();
    refetchPlan();
    return unsubscribe;
  // `snapshot` is intentionally read from stateRef so subscription identity is stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch, refetchPlan, subscribe, workItemId]);

  const { retryReceipts, begin, fail } = useTaskRetryReceipts(workItemId, snapshot, subscribe, refetch);

  const sendAction = useCallback((action: GraphInspectorAction) => {
    const command = workItemId ? graphActionToCommand(action,workItemId) : null;
    if (command && send && controlsEnabled && begin(action)) {
      try { send(command); } catch (error) { fail(action, error); }
    }
  }, [send,workItemId,controlsEnabled,begin,fail]);

  const approvePlan = useCallback(() => {
    if (!workItemId || !planSnapshot || !planControlsEnabled || !planSnapshot.canStart) return;
    send?.({ type: "approve_task_graph_plan", requestId: randomUuid(), workItemId,
      proposalId: planSnapshot.proposalId,
      expectedProposalRevision: planSnapshot.proposalRevision });
  }, [send, workItemId, planSnapshot, planControlsEnabled]);

  const rejectPlan = useCallback(() => {
    if (!workItemId || !planSnapshot || !planControlsEnabled) return;
    send?.({ type: "reject_task_graph_plan", requestId: randomUuid(), workItemId,
      proposalId: planSnapshot.proposalId,
      expectedProposalRevision: planSnapshot.proposalRevision });
  }, [send, workItemId, planSnapshot, planControlsEnabled]);

  const refreshSnapshot = useCallback(() => {
    refetchPendingRef.current = false;
    refetch();
  }, [refetch]);
  const stale = Boolean((snapshot && !controlsEnabled) || (planSnapshot && !planControlsEnabled));
  return { snapshot, planSnapshot, controlsEnabled, planControlsEnabled, stale,
    refetch: refreshSnapshot, refetchPlan, sendAction, approvePlan, rejectPlan, retryReceipts };
}
