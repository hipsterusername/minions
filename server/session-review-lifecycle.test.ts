import { describe, expect, it } from "vitest";
import {
  acknowledgeReview,
  dismissReview,
  finishRun,
  initialSessionReviewLifecycle,
  commitReviewLifecycle,
  reopenReview,
  requestDecision,
} from "./session-review-lifecycle.ts";

describe("session review lifecycle", () => {
  it("classifies clean completion independently of optional report metadata", () => {
    const initial = { ...initialSessionReviewLifecycle(), dashboardRevision: 4 };
    expect(finishRun(initial, { reason: "completed", report: "Done", at: 10 })).toMatchObject({
      reviewState: "completion_to_review",
      finalReport: "Done",
      finalDashboardRevision: 4,
    });
    expect(finishRun(initial, { reason: "completed", report: "", at: 10 })).toMatchObject({
      reviewState: "completion_to_review",
      reviewReason: "Review the completed session",
      finalReport: null,
      finalDashboardRevision: 4,
    });
  });

  it("models decision, acknowledge, dismiss, and reopen deterministically", () => {
    const decision = requestDecision(initialSessionReviewLifecycle(), "Choose a migration");
    const acknowledged = acknowledgeReview(decision, 20);
    const dismissed = dismissReview(acknowledged, 30);
    expect(decision.reviewState).toBe("decision_needed");
    expect(acknowledged).toMatchObject({ reviewState: "decision_needed", acknowledgedAt: 20 });
    expect(reopenReview(dismissed)).toMatchObject({
      reviewState: "decision_needed",
      acknowledgedAt: 20,
      dismissedAt: null,
    });
  });

  it("classifies errors and aborts without parsing prose", () => {
    const initial = initialSessionReviewLifecycle();
    expect(finishRun(initial, { reason: "error", report: "boom", at: 1 }).reviewState)
      .toBe("error_to_review");
    expect(finishRun(initial, { reason: "abort", at: 1 }).reviewState)
      .toBe("interrupted_to_review");
  });

  it("persists canonical run history without emitting a competing session lifecycle", () => {
    const events: unknown[] = [];
    let persisted = 0;
    const host = {
      id: "run-1",
      workItemId: "work-1",
      reviewLifecycle: initialSessionReviewLifecycle(),
      persist: () => { persisted += 1; },
      bufferEvent: (event: unknown) => events.push(event),
    };
    commitReviewLifecycle(host, { emitToSession: (_key, event) => events.push(event) },
      finishRun(host.reviewLifecycle, { reason: "completed", report: "Done", at: 1 }), 1);
    expect(persisted).toBe(1);
    expect(host.reviewLifecycle.reviewState).toBe("completion_to_review");
    expect(events).toEqual([]);
  });
});
