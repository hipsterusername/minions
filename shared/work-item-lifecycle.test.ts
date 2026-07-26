import { describe, expect, it } from "vitest";
import {
  initialWorkItemLifecycle,
  projectLegacySessionLifecycle,
  selectWorkItemPresentation,
  transitionWorkItemLifecycle,
  workItemLifecycleSchema,
  type LegacySessionReviewLifecycle,
  type LegacySessionStatus,
} from "./work-item-lifecycle.ts";

const legacy = (overrides: Partial<LegacySessionReviewLifecycle> = {}): LegacySessionReviewLifecycle => ({
  reviewState: "none",
  finalReport: null,
  terminalReason: null,
  acknowledgedAt: null,
  dismissedAt: null,
  lifecycleRevision: 0,
  ...overrides,
});

describe("work-item lifecycle transitions", () => {
  it("runs, waits, resumes, and seals one open iteration", () => {
    const draft = initialWorkItemLifecycle();
    const starting = transitionWorkItemLifecycle(draft, { type: "start_iteration" });
    const working = transitionWorkItemLifecycle(starting, { type: "harness_started" });
    const waiting = transitionWorkItemLifecycle(working, { type: "wait" });
    const resumed = transitionWorkItemLifecycle(waiting, { type: "resume" });
    const completed = transitionWorkItemLifecycle(resumed, {
      type: "seal", outcome: "completed", hasFinalReport: true,
    });
    expect(completed).toMatchObject({ runtimeState: "inactive", outcome: "completed", resolution: "open", lifecycleRevision: 5 });
  });

  it("seals every declared outcome verbatim when a completed run carries its report", () => {
    for (const outcome of ["completed", "error", "stopped", "interrupted"] as const) {
      const starting = transitionWorkItemLifecycle(initialWorkItemLifecycle(), { type: "start_iteration" });
      expect(transitionWorkItemLifecycle(starting, { type: "seal", outcome, hasFinalReport: true }).outcome)
        .toBe(outcome);
    }
  });

  it("downgrades a nominal completion without its persisted report to interrupted", () => {
    const starting = transitionWorkItemLifecycle(initialWorkItemLifecycle(), { type: "start_iteration" });
    expect(transitionWorkItemLifecycle(starting, { type: "seal", outcome: "completed" }).outcome)
      .toBe("interrupted");
    expect(transitionWorkItemLifecycle(starting, { type: "seal", outcome: "completed", hasFinalReport: false }).outcome)
      .toBe("interrupted");
  });

  it("atomically reopens every terminal outcome for another iteration", () => {
    for (const outcome of ["completed", "error", "stopped", "interrupted"] as const) {
      const starting = transitionWorkItemLifecycle(initialWorkItemLifecycle(), { type: "start_iteration" });
      const terminal = transitionWorkItemLifecycle(starting, {
        type: "seal", outcome,
      });
      const reviewed = transitionWorkItemLifecycle(terminal, { type: "review" });
      expect(transitionWorkItemLifecycle(reviewed, { type: "start_iteration" })).toMatchObject({
        runtimeState: "starting", outcome: "none", resolution: "open",
      });
    }
  });

  it("rejects illegal cross-dimensional states and transitions", () => {
    expect(workItemLifecycleSchema.safeParse({
      ...initialWorkItemLifecycle(), runtimeState: "working", outcome: "error",
    }).success).toBe(false);
    expect(workItemLifecycleSchema.safeParse({
      ...initialWorkItemLifecycle(), changeMode: "live", integrationState: "worktree_active",
    }).success).toBe(false);
    expect(() => transitionWorkItemLifecycle(initialWorkItemLifecycle(), { type: "review" }))
      .toThrow("terminal outcome");
  });

  it("makes duplicate review and archive transitions idempotent", () => {
    const open = transitionWorkItemLifecycle(
      transitionWorkItemLifecycle(initialWorkItemLifecycle(), { type: "start_iteration" }),
      { type: "seal", outcome: "error" },
    );
    const reviewed = transitionWorkItemLifecycle(open, { type: "review" });
    expect(transitionWorkItemLifecycle(reviewed, { type: "review" })).toBe(reviewed);
    const archived = transitionWorkItemLifecycle(reviewed, { type: "archive" });
    expect(transitionWorkItemLifecycle(archived, { type: "archive" })).toBe(archived);
  });

  it("archives and restores a never-started draft without inventing an outcome", () => {
    const draft = initialWorkItemLifecycle();
    const archived = transitionWorkItemLifecycle(draft, { type: "archive" });
    expect(archived).toMatchObject({ runtimeState: "draft", outcome: "none", resolution: "archived" });
    expect(transitionWorkItemLifecycle(archived, { type: "restore", priorResolution: "open" }))
      .toMatchObject({ runtimeState: "draft", outcome: "none", resolution: "open" });
  });

  it.each(["open", "reviewed"] as const)("restores the resolution captured before archive: %s", (priorResolution) => {
    const terminal = workItemLifecycleSchema.parse({
      ...initialWorkItemLifecycle(), runtimeState: "inactive", outcome: "completed",
      resolution: priorResolution,
    });
    const archived = transitionWorkItemLifecycle(terminal, { type: "archive" });
    expect(transitionWorkItemLifecycle(archived, { type: "restore", priorResolution }).resolution)
      .toBe(priorResolution);
    expect(() => transitionWorkItemLifecycle(terminal, { type: "restore", priorResolution }))
      .toThrow("only an archived");
  });

  it.each(["worktree_queued", "worktree_integrating"] as const)(
    "blocks iteration start and archive while integration is %s",
    (integrationState) => {
      const state = workItemLifecycleSchema.parse({
        ...initialWorkItemLifecycle("worktree"),
        runtimeState: "inactive",
        integrationState,
      });
      expect(() => transitionWorkItemLifecycle(state, { type: "start_iteration" }))
        .toThrow("cannot start an iteration");
      expect(() => transitionWorkItemLifecycle(state, { type: "archive" }))
        .toThrow("cannot archive");
    },
  );

  it("starts a conflict-resolution iteration in the preserved worktree", () => {
    const conflicted = workItemLifecycleSchema.parse({
      ...initialWorkItemLifecycle("worktree"), runtimeState: "inactive",
      integrationState: "worktree_conflicted",
    });
    expect(transitionWorkItemLifecycle(conflicted, { type: "start_iteration" })).toMatchObject({
      runtimeState: "starting", outcome: "none", resolution: "open",
      integrationState: "worktree_active",
    });
    expect(() => transitionWorkItemLifecycle(conflicted, { type: "archive" }))
      .toThrow("cannot archive");
  });

  it("allows only adjacent integration transitions and treats terminal states as final", () => {
    let state = initialWorkItemLifecycle("worktree");
    expect(() => transitionWorkItemLifecycle(state, {
      type: "set_integration_state", integrationState: "worktree_integrating",
    })).toThrow("illegal integration transition");
    for (const integrationState of [
      "worktree_active", "worktree_queued", "worktree_integrating", "worktree_conflicted", "worktree_queued", "worktree_integrating", "worktree_integrated",
    ] as const) {
      state = transitionWorkItemLifecycle(state, { type: "set_integration_state", integrationState });
    }
    expect(() => transitionWorkItemLifecycle(state, {
      type: "set_integration_state", integrationState: "worktree_active",
    })).toThrow("illegal integration transition");
  });

  it.each(["worktree_integrated", "worktree_discarded"] as const)(
    "resets terminal integration state %s when starting a new iteration",
    (integrationState) => {
      const terminal = workItemLifecycleSchema.parse({
        ...initialWorkItemLifecycle("worktree"),
        runtimeState: "inactive",
        outcome: "completed",
        resolution: "reviewed",
        integrationState,
      });
      const starting = transitionWorkItemLifecycle(terminal, { type: "start_iteration" });
      expect(starting).toMatchObject({
        runtimeState: "starting",
        outcome: "none",
        resolution: "open",
        integrationState: "worktree_unprovisioned",
      });
      expect(transitionWorkItemLifecycle(starting, {
        type: "set_integration_state", integrationState: "worktree_active",
      }).integrationState).toBe("worktree_active");
    },
  );

  it("preserves an active lineage when starting a revision iteration", () => {
    const active = workItemLifecycleSchema.parse({
      ...initialWorkItemLifecycle("worktree"),
      runtimeState: "inactive",
      integrationState: "worktree_active",
    });
    expect(transitionWorkItemLifecycle(active, { type: "start_iteration" }).integrationState)
      .toBe("worktree_active");
  });

  it("models the live lease adjacency explicitly", () => {
    const editing = transitionWorkItemLifecycle(initialWorkItemLifecycle(), {
      type: "set_integration_state", integrationState: "live_editing",
    });
    const conflict = transitionWorkItemLifecycle(editing, {
      type: "set_integration_state", integrationState: "live_conflict_wait",
    });
    expect(transitionWorkItemLifecycle(conflict, {
      type: "set_integration_state", integrationState: "live_clean",
    }).integrationState).toBe("live_clean");
    expect(() => transitionWorkItemLifecycle(initialWorkItemLifecycle(), {
      type: "set_integration_state", integrationState: "worktree_active",
    })).toThrow("illegal integration transition");
  });
});

describe("canonical presentation selector", () => {
  it.each([
    ["starting", "none", "open", "Starting"],
    ["working", "none", "open", "Working"],
    ["inactive", "completed", "open", "Ready for review"],
    ["inactive", "error", "open", "Error"],
    ["inactive", "interrupted", "open", "Interrupted"],
    ["inactive", "completed", "reviewed", "Reviewed"],
    ["inactive", "completed", "archived", "Archived"],
  ] as const)("maps %s/%s/%s to %s", (runtimeState, outcome, resolution, label) => {
    const state = workItemLifecycleSchema.parse({
      ...initialWorkItemLifecycle(), runtimeState, outcome, resolution,
    });
    expect(selectWorkItemPresentation(state).label).toBe(label);
  });

  it("distinguishes decision, file-conflict, and generic waits", () => {
    const waiting = workItemLifecycleSchema.parse({ ...initialWorkItemLifecycle(), runtimeState: "waiting" });
    expect(selectWorkItemPresentation(waiting, { waitKind: "decision" }).label).toBe("Decision needed");
    expect(selectWorkItemPresentation(waiting, { waitKind: "file_conflict" }).label).toBe("Waiting for files");
    expect(selectWorkItemPresentation(waiting).label).toBe("Waiting");
  });

  it("elevates a child file conflict while the primary remains working", () => {
    const state = workItemLifecycleSchema.parse({ ...initialWorkItemLifecycle(),
      runtimeState: "working", integrationState: "live_conflict_wait" });
    expect(selectWorkItemPresentation(state)).toMatchObject({
      label: "Waiting for files", badge: "waiting", needsAttention: true,
    });
  });

  it("projects integration states consistently", () => {
    const active = transitionWorkItemLifecycle(initialWorkItemLifecycle("worktree"), { type: "set_integration_state", integrationState: "worktree_active" });
    const queued = transitionWorkItemLifecycle(active, { type: "set_integration_state", integrationState: "worktree_queued" });
    const integrating = transitionWorkItemLifecycle(queued, { type: "set_integration_state", integrationState: "worktree_integrating" });
    const conflicted = transitionWorkItemLifecycle(integrating, { type: "set_integration_state", integrationState: "worktree_conflicted" });
    expect(selectWorkItemPresentation(integrating)).toMatchObject({ label: "Integrating", needsAttention: false });
    expect(selectWorkItemPresentation(conflicted)).toMatchObject({ label: "Merge conflict", needsAttention: true });
  });

  it("keeps integration progress and conflicts visible over reviewed or archived resolution", () => {
    const reviewedIntegrating = workItemLifecycleSchema.parse({
      ...initialWorkItemLifecycle("worktree"), runtimeState: "inactive", outcome: "completed",
      resolution: "reviewed", integrationState: "worktree_integrating",
    });
    const archivedConflict = workItemLifecycleSchema.parse({
      ...reviewedIntegrating, resolution: "archived", integrationState: "worktree_conflicted",
    });
    expect(selectWorkItemPresentation(reviewedIntegrating).label).toBe("Integrating");
    expect(selectWorkItemPresentation(archivedConflict).label).toBe("Merge conflict");
  });

  it("allows a never-started inactive item to start", () => {
    const inactive = workItemLifecycleSchema.parse({
      ...initialWorkItemLifecycle(), runtimeState: "inactive",
    });
    expect(selectWorkItemPresentation(inactive).availableActions).toContain("start_iteration");
    expect(transitionWorkItemLifecycle(inactive, { type: "start_iteration" }).runtimeState).toBe("starting");
  });
});

describe("legacy session lifecycle compatibility", () => {
  it.each([
    ["running", legacy(), "working", "none", "open", "Working"],
    ["waiting", legacy({ reviewState: "decision_needed" }), "waiting", "none", "open", "Decision needed"],
    ["idle", legacy({ reviewState: "completion_to_review", terminalReason: "completed", finalReport: "Done" }), "inactive", "completed", "open", "Ready for review"],
    ["idle", legacy({ reviewState: "completion_to_review", terminalReason: "completed" }), "inactive", "interrupted", "open", "Interrupted"],
    ["error", legacy({ reviewState: "error_to_review", terminalReason: "error" }), "inactive", "error", "open", "Error"],
    ["stopped", legacy({ reviewState: "interrupted_to_review", terminalReason: "abort" }), "inactive", "interrupted", "open", "Interrupted"],
    ["idle", legacy({ reviewState: "completion_to_review", terminalReason: "completed", finalReport: "Done", acknowledgedAt: 5 }), "inactive", "completed", "reviewed", "Reviewed"],
    ["idle", legacy({ reviewState: "completion_to_review", terminalReason: "completed", finalReport: "Done", dismissedAt: 5 }), "inactive", "completed", "archived", "Archived"],
  ] as const)("projects %s fixture unambiguously", (status, reviewLifecycle, runtimeState, outcome, resolution, label) => {
    const projected = projectLegacySessionLifecycle({ status: status as LegacySessionStatus, reviewLifecycle });
    expect(projected.lifecycle).toMatchObject({ runtimeState, outcome, resolution });
    expect(selectWorkItemPresentation(projected.lifecycle, { waitKind: projected.waitKind }).label).toBe(label);
  });

  it("never infers completion from idle or a completed status without a report", () => {
    expect(projectLegacySessionLifecycle({ status: "idle", reviewLifecycle: legacy() }).lifecycle.outcome).toBe("none");
    expect(projectLegacySessionLifecycle({ status: "completed", reviewLifecycle: legacy() }).lifecycle.outcome).toBe("interrupted");
  });

  it.each([
    ["error", legacy({ reviewState: "decision_needed" }), "error"],
    ["stopped", legacy({ reviewState: "decision_needed" }), "interrupted"],
    ["disconnected", legacy({ reviewState: "decision_needed" }), "interrupted"],
    ["running", legacy({ reviewState: "decision_needed", terminalReason: "completed", finalReport: "Done" }), "completed"],
    ["running", legacy({ reviewState: "decision_needed", terminalReason: "abort" }), "interrupted"],
  ] as const)("lets terminal recovery evidence override stale decisions for %s", (status, reviewLifecycle, outcome) => {
    const projected = projectLegacySessionLifecycle({ status: status as LegacySessionStatus, reviewLifecycle });
    expect(projected.lifecycle).toMatchObject({ runtimeState: "inactive", outcome });
    expect(projected.waitKind).toBeNull();
  });
});
