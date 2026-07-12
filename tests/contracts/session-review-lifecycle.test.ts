import { describe, expect, it } from "vitest";
import { sessionLifecycleChangedEnvelopeSchema } from "../../shared/ws-envelope.ts";

describe("session lifecycle envelope contract", () => {
  it("accepts the canonical session-scoped lifecycle snapshot", () => {
    const parsed = sessionLifecycleChangedEnvelopeSchema.parse({
      topic: "session:leader-1",
      type: "session_lifecycle_changed",
      sessionKey: "leader-1",
      lifecycle: {
        reviewState: "completion_to_review",
        reviewReason: "Read the final report and review the dashboard",
        finalReport: "Done",
        finalDashboardRevision: 2,
        dashboardRevision: 2,
        terminalReason: "completed",
        terminalAt: 10,
        acknowledgedAt: null,
        dismissedAt: null,
        lifecycleRevision: 3,
      },
      timestamp: 10,
    });
    expect(parsed.topic).toBe("session:leader-1");
  });

  it("rejects an unversioned lifecycle snapshot", () => {
    const result = sessionLifecycleChangedEnvelopeSchema.safeParse({
      topic: "session:leader-1",
      type: "session_lifecycle_changed",
      sessionKey: "leader-1",
      lifecycle: { reviewState: "none" },
      timestamp: 10,
    });
    expect(result.success).toBe(false);
  });
});
