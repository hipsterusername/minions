import { describe, expect, it } from "vitest";

import {
  buildLifecycleCommand,
  canAcknowledge,
  isDismissed,
} from "./mobile-activity-actions.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";

function session(overrides: Partial<MobileSessionInfo>): MobileSessionInfo {
  return {
    sessionKey: overrides.sessionKey ?? "s-1",
    sessionId: null,
    status: overrides.status ?? "waiting",
    cwd: "/tmp/project",
    ...overrides,
  };
}

const lifecycle = {
  reviewState: "decision_needed" as const,
  reviewReason: "Needs a decision",
  finalReport: null,
  finalDashboardRevision: 0,
  dashboardRevision: 0,
  terminalReason: null,
  terminalAt: null,
  acknowledgedAt: null,
  dismissedAt: null,
  lifecycleRevision: 7,
};

describe("buildLifecycleCommand", () => {
  it("targets a bare session by sessionKey", () => {
    const cmd = buildLifecycleCommand("acknowledge", session({ reviewLifecycle: lifecycle }), "req-1");
    expect(cmd).toEqual({
      type: "acknowledge_session",
      sessionKey: "s-1",
      expectedLifecycleRevision: 7,
    });
  });

  it("routes a canonical work-item session through work-item commands with run fencing", () => {
    const cmd = buildLifecycleCommand(
      "dismiss",
      session({ sessionKey: "run-9", workItemId: "work-9", canonicalWorkItem: true, reviewLifecycle: lifecycle }),
      "req-2",
    );
    expect(cmd).toEqual({
      type: "archive_work_item",
      workItemId: "work-9",
      requestId: "req-2",
      expectedCurrentRunKey: "run-9",
      expectedLifecycleRevision: 7,
    });
  });

  it("nulls the fenced run key for synthetic work-item session keys", () => {
    const cmd = buildLifecycleCommand(
      "reopen",
      session({ sessionKey: "work-item:draft", workItemId: "work-9", canonicalWorkItem: true, reviewLifecycle: lifecycle }),
      "req-3",
    );
    expect(cmd).toMatchObject({ type: "restore_work_item", expectedCurrentRunKey: null });
  });

  // Bug regression: a session can reference a work item whose canonical
  // snapshot is not loaded (e.g. a legacy-migrated item under a stale
  // projectId). Its reviewLifecycle revision is the SESSION's counter, not the
  // work item's — sending it to archive_work_item made the server reject the
  // dismiss with "stale work-item lifecycle". Such sessions must use the
  // session envelope, which resolves fresh work-item state server-side.
  it("routes a non-canonical work-item session through session commands", () => {
    const cmd = buildLifecycleCommand(
      "dismiss",
      session({ sessionKey: "leader-new", workItemId: "legacy-work-1", reviewLifecycle: lifecycle }),
      "req-5",
    );
    expect(cmd).toEqual({
      type: "dismiss_session",
      sessionKey: "leader-new",
      expectedLifecycleRevision: 7,
    });
  });

  it("routes non-canonical acknowledge and reopen through session commands too", () => {
    const orphan = session({ sessionKey: "leader-new", workItemId: "legacy-work-1", reviewLifecycle: lifecycle });
    expect(buildLifecycleCommand("acknowledge", orphan, "req-6"))
      .toMatchObject({ type: "acknowledge_session", sessionKey: "leader-new" });
    expect(buildLifecycleCommand("reopen", orphan, "req-7"))
      .toMatchObject({ type: "reopen_session", sessionKey: "leader-new" });
  });

  it("defaults the expected revision to 0 when no lifecycle is present", () => {
    expect(buildLifecycleCommand("acknowledge", session({}), "req-4"))
      .toMatchObject({ expectedLifecycleRevision: 0 });
  });
});

describe("canAcknowledge / isDismissed", () => {
  it.each(["completion_to_review", "error_to_review", "interrupted_to_review"] as const)(
    "allows acknowledge only for open, un-acknowledged %s outcomes", (reviewState) => {
      const terminalLifecycle = { ...lifecycle, reviewState };
      expect(canAcknowledge(session({ reviewLifecycle: terminalLifecycle }))).toBe(true);
      expect(canAcknowledge(session({ reviewLifecycle: { ...terminalLifecycle, acknowledgedAt: 1 } }))).toBe(false);
      expect(canAcknowledge(session({ reviewLifecycle: { ...terminalLifecycle, dismissedAt: 1 } }))).toBe(false);
      expect(canAcknowledge(session({ reviewLifecycle: { ...lifecycle, reviewState: "none" } }))).toBe(false);
      expect(canAcknowledge(session({}))).toBe(false);
    });

  it.each([false, true])("does not acknowledge an unanswered decision (canonical: %s)", (canonicalWorkItem) => {
    expect(canAcknowledge(session({ canonicalWorkItem,
      ...(canonicalWorkItem ? { workItemId: "work-1" } : {}),
      reviewLifecycle: lifecycle,
    }))).toBe(false);
  });

  it("reports dismissed state from the lifecycle", () => {
    expect(isDismissed(session({ reviewLifecycle: lifecycle }))).toBe(false);
    expect(isDismissed(session({ reviewLifecycle: { ...lifecycle, dismissedAt: 9 } }))).toBe(true);
  });
});
