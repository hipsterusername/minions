export type {
  AttemptState, BlockerCategory, GraphRunStatus, LogicalState, ReadinessState,
  TaskAttemptView, TaskGraphNodeView, TaskGraphSnapshotView, VerificationState,
} from "../../shared/task-graph-view-contracts.ts";
import type { TaskGraphNodeView } from "../../shared/task-graph-view-contracts.ts";

export type GraphNodeKind = TaskGraphNodeView["kind"];
export type TaskGraphEdgeView = import("../../shared/task-graph-view-contracts.ts").TaskGraphSnapshotView["edges"][number];
export type TaskGraphGroupView = import("../../shared/task-graph-view-contracts.ts").TaskGraphSnapshotView["groups"][number];
export type EvidenceLineageView = import("../../shared/task-graph-view-contracts.ts").TaskGraphSnapshotView["evidence"][number];
export type GraphTimelineEventView = import("../../shared/task-graph-view-contracts.ts").TaskGraphSnapshotView["timeline"][number];

export type GraphFilter =
  | "all"
  | "active"
  | "attention"
  | "ready"
  | "blocked"
  | "failed"
  | "unverified"
  | "expensive"
  | "stale"
  | "critical";

/**
 * A deliberately small, structural view of the authored Leader plan.
 *
 * The graph UI does not own plan state. Keeping this interface independent of
 * LeaderData lets the inspector consume the canonical plan without persisting
 * a second copy or coupling the task-graph package to the Leader renderer.
 */
export interface GraphPlanItem {
  taskId: string;
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  status:
    | "planned"
    | "starting"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "ended_without_report"
    | "cancelled"
    | "orphaned";
  executor: "leader" | "minion";
  minionSessionKey?: string | null;
  result?: string | null;
  cost?: number;
  activeStep?: string | null | undefined;
}

export interface GraphActionFence {
  requestId: string;
  graphRunId: string;
  expectedRunRevision: number;
  nodeId: string | null;
  currentAttemptId: string | null;
}

export type GraphInspectorAction =
  | (GraphActionFence & { type: "pause" | "resume" })
  | (GraphActionFence & { type: "retry" | "cancel_attempt" | "request_verification" })
  | (GraphActionFence & { type: "waive_verification"; reason:string })
  | (GraphActionFence & {type:"adjudicate";decision:"accepted"|"rejected"|"retry";
      reason:string;guidance?:string})
  | (GraphActionFence & { type: "provide_input"; input: string })
  | (GraphActionFence & { type: "cancel_run" });

export interface GraphInspectorCallbacks {
  onAction: (action: GraphInspectorAction) => void;
  createRequestId?: () => string;
}
