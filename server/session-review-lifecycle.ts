export type SessionReviewState =
  | "none"
  | "decision_needed"
  | "completion_to_review"
  | "error_to_review"
  | "interrupted_to_review";

export type SessionTerminalReason = "completed" | "error" | "stop" | "abort" | null;

export interface SessionReviewLifecycle {
  reviewState: SessionReviewState;
  reviewReason: string | null;
  finalReport: string | null;
  finalDashboardRevision: number | null;
  dashboardRevision: number;
  terminalReason: SessionTerminalReason;
  terminalAt: number | null;
  acknowledgedAt: number | null;
  dismissedAt: number | null;
  lifecycleRevision: number;
}

export function initialSessionReviewLifecycle(): SessionReviewLifecycle {
  return {
    reviewState: "none",
    reviewReason: null,
    finalReport: null,
    finalDashboardRevision: null,
    dashboardRevision: 0,
    terminalReason: null,
    terminalAt: null,
    acknowledgedAt: null,
    dismissedAt: null,
    lifecycleRevision: 0,
  };
}

export function reviewLifecycleToColumns(state = initialSessionReviewLifecycle()) {
  return {
    review_state: state.reviewState,
    review_reason: state.reviewReason,
    final_report: state.finalReport,
    final_dashboard_revision: state.finalDashboardRevision,
    dashboard_revision: state.dashboardRevision,
    terminal_reason: state.terminalReason,
    terminal_at: state.terminalAt,
    acknowledged_at: state.acknowledgedAt,
    dismissed_at: state.dismissedAt,
    lifecycle_revision: state.lifecycleRevision,
  };
}

export function beginRun(state: SessionReviewLifecycle): SessionReviewLifecycle {
  return {
    ...state,
    reviewState: "none",
    reviewReason: null,
    finalReport: null,
    finalDashboardRevision: null,
    terminalReason: null,
    terminalAt: null,
    acknowledgedAt: null,
    dismissedAt: null,
    lifecycleRevision: state.lifecycleRevision + 1,
  };
}

export function requestDecision(
  state: SessionReviewLifecycle,
  reason: string,
): SessionReviewLifecycle {
  const normalizedReason = reason.trim() || "Input requested";
  if (
    state.reviewState === "decision_needed" &&
    state.reviewReason === normalizedReason &&
    state.acknowledgedAt === null &&
    state.dismissedAt === null
  ) return state;
  return {
    ...state,
    reviewState: "decision_needed",
    reviewReason: normalizedReason,
    acknowledgedAt: null,
    dismissedAt: null,
    lifecycleRevision: state.lifecycleRevision + 1,
  };
}

export function finishRun(
  state: SessionReviewLifecycle,
  input: { reason: Exclude<SessionTerminalReason, null>; report?: string | null; at: number },
): SessionReviewLifecycle {
  const report = input.report?.trim() || null;
  let reviewState: SessionReviewState;
  let reviewReason: string;
  if (input.reason === "error") {
    reviewState = "error_to_review";
    reviewReason = report ?? "Session ended with an error";
  } else if (input.reason === "completed") {
    reviewState = "completion_to_review";
    reviewReason = report
      ? "Read the final report and review the dashboard"
      : "Review the completed session";
  } else {
    reviewState = "interrupted_to_review";
    reviewReason = "Session ended before clean completion was recorded";
  }
  return {
    ...state,
    reviewState,
    reviewReason,
    finalReport: input.reason === "completed" ? report : null,
    finalDashboardRevision:
      input.reason === "completed" ? state.dashboardRevision : null,
    terminalReason: input.reason,
    terminalAt: input.at,
    acknowledgedAt: null,
    dismissedAt: null,
    lifecycleRevision: state.lifecycleRevision + 1,
  };
}

export function acknowledgeReview(
  state: SessionReviewLifecycle,
  at: number,
): SessionReviewLifecycle {
  if (state.reviewState === "none" || state.acknowledgedAt !== null) return state;
  return {
    ...state,
    acknowledgedAt: at,
    lifecycleRevision: state.lifecycleRevision + 1,
  };
}

export function dismissReview(
  state: SessionReviewLifecycle,
  at: number,
): SessionReviewLifecycle {
  if (state.dismissedAt !== null) return state;
  return {
    ...state,
    dismissedAt: at,
    lifecycleRevision: state.lifecycleRevision + 1,
  };
}

export function reopenReview(state: SessionReviewLifecycle): SessionReviewLifecycle {
  if (state.dismissedAt === null) return state;
  return {
    ...state,
    dismissedAt: null,
    lifecycleRevision: state.lifecycleRevision + 1,
  };
}

export function incrementDashboardRevision(
  state: SessionReviewLifecycle,
): SessionReviewLifecycle {
  return { ...state, dashboardRevision: state.dashboardRevision + 1 };
}

export interface ReviewLifecycleHost {
  id: string;
  workItemId?: string | null;
  reviewLifecycle: SessionReviewLifecycle;
  persist(): void;
  bufferEvent(event: { type: string; sessionKey: string; timestamp: number; [key: string]: unknown }): void;
}

export interface ReviewLifecycleBus {
  emitToSession(sessionKey: string, payload: { type: string; [key: string]: unknown }): void;
}

export function commitReviewLifecycle(
  host: ReviewLifecycleHost,
  bus: ReviewLifecycleBus,
  next: SessionReviewLifecycle,
  timestamp: number = Date.now(),
): void {
  if (next === host.reviewLifecycle) return;
  host.reviewLifecycle = next;
  host.persist();
  // Canonical runs retain this snapshot as immutable run history, but the
  // work-item event is the only live lifecycle authority exposed to clients.
  if (host.workItemId) return;
  const event = {
    type: "session_lifecycle_changed",
    sessionKey: host.id,
    lifecycle: next,
    timestamp,
  };
  host.bufferEvent(event);
  bus.emitToSession(host.id, event);
}

export function reviewLifecycleCallbacks(host: ReviewLifecycleHost, bus: ReviewLifecycleBus) {
  return {
    markDecisionNeeded: (reason: string) =>
      commitReviewLifecycle(host, bus, requestDecision(host.reviewLifecycle, reason)),
    markDashboardChanged: () =>
      commitReviewLifecycle(host, bus, incrementDashboardRevision(host.reviewLifecycle)),
  };
}
