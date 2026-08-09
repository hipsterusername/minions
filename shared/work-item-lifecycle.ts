import { z } from "zod/v4";

export const runtimeStateSchema = z.enum(["draft", "starting", "working", "waiting", "inactive"]);
export const outcomeSchema = z.enum(["none", "completed", "error", "stopped", "interrupted"]);
export const resolutionSchema = z.enum(["open", "reviewed", "archived"]);
export const changeModeSchema = z.enum(["live", "worktree"]);
export const integrationStateSchema = z.enum([
  "live_clean",
  "live_editing",
  "live_conflict_wait",
  "worktree_unprovisioned",
  "worktree_active",
  "worktree_queued",
  "worktree_integrating",
  "worktree_conflicted",
  "worktree_integrated",
  "worktree_discarded",
]);

export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type ChangeMode = z.infer<typeof changeModeSchema>;
export type IntegrationState = z.infer<typeof integrationStateSchema>;

export interface WorkItemLifecycle {
  runtimeState: RuntimeState;
  outcome: Outcome;
  resolution: Resolution;
  changeMode: ChangeMode;
  integrationState: IntegrationState;
  lifecycleRevision: number;
}

function lifecycleIssue(state: Omit<WorkItemLifecycle, "lifecycleRevision">): string | null {
  if (state.runtimeState !== "inactive" && state.outcome !== "none") {
    return "an active or draft work item cannot have a terminal outcome";
  }
  if (state.resolution === "reviewed" && state.outcome === "none") {
    return "reviewed requires a terminal outcome";
  }
  if (state.resolution === "archived" && !["draft", "inactive"].includes(state.runtimeState)) {
    return "archived requires a draft or inactive runtime";
  }
  if (state.changeMode === "live" && !state.integrationState.startsWith("live_")) {
    return "live mode requires a live integration state";
  }
  if (state.changeMode === "worktree" && !state.integrationState.startsWith("worktree_")) {
    return "worktree mode requires a worktree integration state";
  }
  return null;
}

export const workItemLifecycleSchema = z.object({
  runtimeState: runtimeStateSchema,
  outcome: outcomeSchema,
  resolution: resolutionSchema,
  changeMode: changeModeSchema,
  integrationState: integrationStateSchema,
  lifecycleRevision: z.number().int().nonnegative(),
}).superRefine((state, ctx) => {
  const issue = lifecycleIssue(state);
  if (issue) ctx.addIssue({ code: "custom", message: issue });
});

export function initialWorkItemLifecycle(
  changeMode: ChangeMode = "live",
): WorkItemLifecycle {
  return {
    runtimeState: "draft",
    outcome: "none",
    resolution: "open",
    changeMode,
    integrationState: changeMode === "live" ? "live_clean" : "worktree_unprovisioned",
    lifecycleRevision: 0,
  };
}

export type WorkItemLifecycleEvent =
  | { type: "start_iteration" }
  | { type: "harness_started" }
  | { type: "wait" }
  | { type: "resume" }
  | { type: "seal"; outcome: Exclude<Outcome, "none"> }
  | { type: "review" }
  | { type: "archive" }
  | { type: "restore"; priorResolution: Exclude<Resolution, "archived"> }
  | { type: "set_integration_state"; integrationState: IntegrationState };

const INTEGRATION_TRANSITIONS: Readonly<Record<IntegrationState, readonly IntegrationState[]>> = {
  live_clean: ["live_editing", "live_conflict_wait"],
  live_editing: ["live_clean", "live_conflict_wait"],
  live_conflict_wait: ["live_clean", "live_editing"],
  worktree_unprovisioned: ["worktree_active", "worktree_discarded"],
  worktree_active: ["worktree_queued", "worktree_discarded"],
  worktree_queued: ["worktree_active", "worktree_integrating", "worktree_discarded"],
  worktree_integrating: ["worktree_queued", "worktree_conflicted", "worktree_integrated"],
  worktree_conflicted: ["worktree_active", "worktree_queued", "worktree_discarded"],
  worktree_integrated: [],
  worktree_discarded: [],
};

const UNSAFE_INTEGRATION_STATES = new Set<IntegrationState>([
  "worktree_queued",
  "worktree_integrating",
  "worktree_conflicted",
]);

/**
 * A pure, strict reducer. Repositories must bind the expected lifecycle
 * revision and currentRunKey in the same CAS transaction around it.
 */
export function transitionWorkItemLifecycle(
  state: WorkItemLifecycle,
  event: WorkItemLifecycleEvent,
): WorkItemLifecycle {
  workItemLifecycleSchema.parse(state);
  let patch: Partial<WorkItemLifecycle>;

  switch (event.type) {
    case "start_iteration":
      if (state.runtimeState !== "draft" && state.runtimeState !== "inactive") {
        throw new Error(`cannot start an iteration while ${state.runtimeState}`);
      }
      if (UNSAFE_INTEGRATION_STATES.has(state.integrationState)
        && state.integrationState !== "worktree_conflicted") {
        throw new Error(`cannot start an iteration while integration is ${state.integrationState}`);
      }
      patch = {
        runtimeState: "starting",
        outcome: "none",
        resolution: "open",
        ...(state.integrationState === "worktree_conflicted"
          ? { integrationState: "worktree_active" as const }
          : {}),
        ...(["worktree_integrated", "worktree_discarded"].includes(state.integrationState)
          ? { integrationState: "worktree_unprovisioned" as const }
          : {}),
      };
      break;
    case "harness_started":
      if (state.runtimeState !== "starting") throw new Error("harness start requires starting runtime");
      patch = { runtimeState: "working" };
      break;
    case "wait":
      if (state.runtimeState !== "working") throw new Error("wait requires working runtime");
      patch = { runtimeState: "waiting" };
      break;
    case "resume":
      if (state.runtimeState !== "waiting") throw new Error("resume requires waiting runtime");
      patch = { runtimeState: "starting" };
      break;
    case "seal": {
      if (!["starting", "working", "waiting"].includes(state.runtimeState)) {
        throw new Error("only an open run can be sealed");
      }
      patch = { runtimeState: "inactive", outcome: event.outcome, resolution: "open" };
      break;
    }
    case "review":
      if (state.outcome === "none") throw new Error("only a terminal outcome can be reviewed");
      if (state.resolution === "reviewed") return state;
      if (state.resolution !== "open") throw new Error("an archived outcome cannot be reviewed");
      patch = { resolution: "reviewed" };
      break;
    case "archive":
      if (!["draft", "inactive"].includes(state.runtimeState)) {
        throw new Error("an active work item must be stopped before it can be archived");
      }
      if (state.resolution === "archived") return state;
      patch = { resolution: "archived" };
      break;
    case "restore":
      if (state.resolution !== "archived") throw new Error("only an archived work item can be restored");
      if (event.priorResolution === "reviewed" && state.outcome === "none") {
        throw new Error("reviewed requires a terminal outcome");
      }
      patch = { resolution: event.priorResolution };
      break;
    case "set_integration_state":
      if (event.integrationState === state.integrationState) return state;
      if (!INTEGRATION_TRANSITIONS[state.integrationState].includes(event.integrationState)) {
        throw new Error(`illegal integration transition: ${state.integrationState} -> ${event.integrationState}`);
      }
      patch = { integrationState: event.integrationState };
      break;
  }

  const next = { ...state, ...patch, lifecycleRevision: state.lifecycleRevision + 1 };
  return workItemLifecycleSchema.parse(next);
}

export type WorkItemWaitKind = "decision" | "file_conflict" | "other";

/**
 * Structured context that must travel with the work-item snapshot.
 * It is deliberately not reconstructed from review prose or a generic wait.
 */
export interface WorkItemPresentationContext {
  waitKind?: WorkItemWaitKind | null;
}
export type WorkItemAction =
  | "start_iteration"
  | "provide_input"
  | "review"
  | "archive"
  | "resolve_conflict";

export interface WorkItemPresentation {
  label: string;
  badge: "neutral" | "active" | "waiting" | "success" | "error" | "archived";
  attentionRank: number;
  needsAttention: boolean;
  availableActions: readonly WorkItemAction[];
}

/**
 * One presentation projection for every surface. waitKind is explicit because
 * runtime=waiting intentionally does not encode why execution paused.
 */
export function selectWorkItemPresentation(
  state: WorkItemLifecycle,
  context: WorkItemPresentationContext = {},
): WorkItemPresentation {
  workItemLifecycleSchema.parse(state);
  const actions: WorkItemAction[] = [];
  if (state.integrationState === "worktree_conflicted") {
    actions.push("resolve_conflict");
    return { label: "Merge conflict", badge: "error", attentionRank: 0, needsAttention: true, availableActions: actions };
  }
  if (["worktree_queued", "worktree_integrating"].includes(state.integrationState)) {
    return { label: "Integrating", badge: "active", attentionRank: 4, needsAttention: false, availableActions: actions };
  }
  if (state.resolution === "archived") {
    return { label: "Archived", badge: "archived", attentionRank: 6, needsAttention: false, availableActions: actions };
  }
  if (state.integrationState === "live_conflict_wait") {
    return { label: "Waiting for files", badge: "waiting", attentionRank: 0,
      needsAttention: true, availableActions: actions };
  }
  if (state.runtimeState === "waiting" && context.waitKind === "decision") {
    actions.push("provide_input");
    return { label: "Decision needed", badge: "waiting", attentionRank: 0, needsAttention: true, availableActions: actions };
  }
  if (state.outcome === "error" && state.resolution === "open") {
    actions.push("review", "start_iteration");
    return { label: "Error", badge: "error", attentionRank: 1, needsAttention: true, availableActions: actions };
  }
  if (state.outcome === "interrupted" && state.resolution === "open") {
    actions.push("review", "start_iteration");
    return { label: "Interrupted", badge: "error", attentionRank: 2, needsAttention: true, availableActions: actions };
  }
  if (state.outcome === "stopped" && state.resolution === "open") {
    actions.push("review", "start_iteration");
    return { label: "Stopped", badge: "neutral", attentionRank: 2, needsAttention: true, availableActions: actions };
  }
  if (state.outcome === "completed" && state.resolution === "open") {
    actions.push("review", "start_iteration");
    return { label: "Ready for review", badge: "success", attentionRank: 3, needsAttention: true, availableActions: actions };
  }
  if (state.resolution === "reviewed") {
    actions.push("archive", "start_iteration");
    return { label: "Reviewed", badge: "success", attentionRank: 5, needsAttention: false, availableActions: actions };
  }
  if (state.runtimeState === "starting") {
    return { label: "Starting", badge: "active", attentionRank: 4, needsAttention: false, availableActions: actions };
  }
  if (state.runtimeState === "working") {
    return { label: "Working", badge: "active", attentionRank: 4, needsAttention: false, availableActions: actions };
  }
  if (state.runtimeState === "waiting") {
    const fileWait = context.waitKind === "file_conflict";
    return {
      label: fileWait ? "Waiting for files" : "Waiting",
      badge: "waiting",
      attentionRank: 4,
      needsAttention: fileWait,
      availableActions: actions,
    };
  }
  if (state.runtimeState === "draft" || (state.runtimeState === "inactive" && state.outcome === "none")) {
    actions.push("start_iteration");
  }
  return { label: state.runtimeState === "draft" ? "Draft" : "Inactive", badge: "neutral", attentionRank: 4, needsAttention: false, availableActions: actions };
}

export interface LegacySessionReviewLifecycle {
  reviewState: "none" | "decision_needed" | "completion_to_review" | "error_to_review" | "interrupted_to_review";
  finalReport: string | null;
  terminalReason: "completed" | "error" | "stop" | "abort" | null;
  acknowledgedAt: number | null;
  dismissedAt: number | null;
  lifecycleRevision: number;
}

export type LegacySessionStatus = "creating" | "running" | "waiting" | "idle" | "stopped" | "error" | "completed" | "disconnected";

export interface LegacyLifecycleProjection {
  lifecycle: WorkItemLifecycle;
  waitKind: WorkItemWaitKind | null;
}

/** Projects persisted session state into the canonical lifecycle without inferring completion from idle. */
export function projectLegacySessionLifecycle(input: {
  status: LegacySessionStatus;
  reviewLifecycle: LegacySessionReviewLifecycle;
  changeMode?: ChangeMode;
  integrationState?: IntegrationState;
}): LegacyLifecycleProjection {
  const { status, reviewLifecycle: review } = input;
  const changeMode = input.changeMode ?? "live";
  const integrationState = input.integrationState
    ?? (changeMode === "live" ? "live_clean" : "worktree_unprovisioned");

  let runtimeState: RuntimeState = status === "creating"
    ? "starting"
    : status === "running"
      ? "working"
      : status === "waiting"
        ? "waiting"
        : "inactive";
  let outcome: Outcome = "none";
  let waitKind: WorkItemWaitKind | null = null;

  const hasTerminalEvidence = review.terminalReason !== null
    || ["stopped", "error", "completed", "disconnected"].includes(status)
    || ["completion_to_review", "error_to_review", "interrupted_to_review"].includes(review.reviewState);

  if (!hasTerminalEvidence && review.reviewState === "decision_needed") {
    runtimeState = "waiting";
    waitKind = "decision";
  } else if (hasTerminalEvidence) {
    outcome = review.terminalReason === "error" || status === "error"
      ? "error"
      : review.terminalReason === "completed" || review.reviewState === "completion_to_review"
        ? "completed"
        : "interrupted";
  }

  if (outcome !== "none") runtimeState = "inactive";
  const resolution: Resolution = outcome === "none"
    ? "open"
    : review.dismissedAt !== null
      ? "archived"
      : review.acknowledgedAt !== null
        ? "reviewed"
        : "open";

  const lifecycle = workItemLifecycleSchema.parse({
    runtimeState,
    outcome,
    resolution,
    changeMode,
    integrationState,
    lifecycleRevision: review.lifecycleRevision,
  });
  return { lifecycle, waitKind };
}
