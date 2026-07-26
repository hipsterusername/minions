import { beforeEach, describe, expect, it, vi } from "vitest";
import { disablePersistence } from "../session-persist.ts";
import { finishRun } from "../session-review-lifecycle.ts";
import { setup, cmd } from "../../tests/support/server-command-harness.ts";
import { acknowledgeSession, dismissSession, reopenSession } from "./session-review.ts";
import type { WorkItemService } from "../work-item-service.ts";
import type { Resolution } from "../../shared/work-item-lifecycle.ts";

function boundDetail(resolution: Resolution, revision: number) {
  return {
    workItem: {
      id: "work-1", projectId: "project-1", projectPath: "/proj", title: "Task",
      lifecycle: { runtimeState: "inactive" as const, outcome: "completed" as const,
        resolution, changeMode: "live" as const, integrationState: "live_clean" as const,
        lifecycleRevision: revision },
      waitKind: null, currentRunKey: "leader-1", iteration: 1,
      workflowColumnId: "backlog", workflowRank: "a", lastTransitionAt: 10,
      createdAt: 1, updatedAt: 10 + revision,
    },
    bindings: [], currentRun: null, runs: [], nextCursor: null,
  };
}

function boundService() {
  const before = boundDetail("open", 4);
  return {
    get: vi.fn(async () => before),
    review: vi.fn(async () => boundDetail("reviewed", 5)),
    archive: vi.fn(async () => boundDetail("archived", 5)),
    restore: vi.fn(async () => boundDetail("reviewed", 5)),
  } as unknown as WorkItemService;
}

beforeEach(() => disablePersistence());

describe("session review commands", () => {
  it.each([
    ["acknowledge", acknowledgeSession, "review", "reviewed", "acknowledgedAt"],
    ["dismiss", dismissSession, "archive", "archived", "dismissedAt"],
    ["reopen", reopenSession, "restore", "reviewed", "dismissedAt"],
  ] as const)("routes bound %s through the canonical service without contradictory snapshots",
    async (action, command, method, resolution, timestampField) => {
      const h = setup({ status: "idle" });
      h.host.workItemId = "work-1";
      h.host.reviewLifecycle = { ...h.host.reviewLifecycle, lifecycleRevision: 4 };
      if (action === "reopen") h.host.reviewLifecycle = { ...h.host.reviewLifecycle, dismissedAt: 2 };
      const workItems = boundService();
      h.ctx.workItems = workItems;
      command(h.ctx, cmd({ type: `${action}_session`, expectedLifecycleRevision: 4 }), h.ws);
      await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
      expect(workItems[method]).toHaveBeenCalledWith(expect.objectContaining({
        workItemId: "work-1", expectedLifecycleRevision: 4, expectedCurrentRunKey: "leader-1",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }));
      const response = h.wsSent[0];
      expect(response).toMatchObject({ success: true,
        lifecycle: { lifecycleRevision: 5 }, workItem: { lifecycle: { resolution, lifecycleRevision: 5 } } });
      if (action === "reopen") expect(h.host.reviewLifecycle[timestampField]).toBeNull();
      else expect(h.host.reviewLifecycle[timestampField]).toBe(15);
      expect(h.busSent.at(-1)).toMatchObject({
        topic: "session:leader-1", type: "session_lifecycle_changed",
        lifecycle: { lifecycleRevision: 5 },
      });
    });

  it("applies a bound dismiss with a stale host clock because dismissal is monotonic", async () => {
    // Regression: after a server restart, boot recovery bumps the session and
    // work-item revision counters independently, so the host clock no longer
    // matches what any client saw. Dismiss/acknowledge are monotonic and the
    // canonical mutation is fenced with the freshly read work-item revision,
    // so a mismatched host clock must not reject the request.
    const h = setup();
    h.host.workItemId = "work-1";
    h.host.reviewLifecycle = { ...h.host.reviewLifecycle, lifecycleRevision: 4 };
    const workItems = boundService();
    h.ctx.workItems = workItems;
    dismissSession(h.ctx, cmd({ type: "dismiss_session", expectedLifecycleRevision: 3 }), h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(workItems.archive).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: "work-1", expectedLifecycleRevision: 4, expectedCurrentRunKey: "leader-1",
    }));
    expect(h.wsSent[0]).toMatchObject({ topic: "session:leader-1", success: true });
  });

  it("still fences a bound reopen strictly because it reverses user intent", async () => {
    const h = setup();
    h.host.workItemId = "work-1";
    h.host.reviewLifecycle = { ...h.host.reviewLifecycle, lifecycleRevision: 4, dismissedAt: 2 };
    const workItems = boundService();
    h.ctx.workItems = workItems;
    reopenSession(h.ctx, cmd({ type: "reopen_session", expectedLifecycleRevision: 3 }), h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(workItems.restore).not.toHaveBeenCalled();
    expect(h.wsSent[0]).toMatchObject({
      topic: "session:leader-1", success: false, code: "LIFECYCLE_REVISION_CONFLICT",
      lifecycle: { lifecycleRevision: 4 },
    });
  });

  it("acknowledges, dismisses, and restores without losing the outcome", () => {
    const h = setup({ status: "idle" });
    h.host.reviewLifecycle = finishRun(h.host.reviewLifecycle, {
      reason: "completed",
      report: "Final report",
      at: 1,
    });
    acknowledgeSession(h.ctx, cmd({
      type: "acknowledge_session",
      expectedLifecycleRevision: 1,
    }), h.ws);
    expect(h.host.reviewLifecycle).toMatchObject({
      reviewState: "completion_to_review",
      acknowledgedAt: expect.any(Number),
      lifecycleRevision: 2,
    });
    dismissSession(h.ctx, cmd({
      type: "dismiss_session",
      expectedLifecycleRevision: 2,
    }), h.ws);
    expect(h.host.reviewLifecycle.dismissedAt).not.toBeNull();
    reopenSession(h.ctx, cmd({
      type: "reopen_session",
      expectedLifecycleRevision: 3,
    }), h.ws);
    expect(h.host.reviewLifecycle).toMatchObject({
      reviewState: "completion_to_review",
      dismissedAt: null,
      lifecycleRevision: 4,
    });
  });

  it("applies stale dismiss requests to the latest outcome because dismissal is monotonic", () => {
    const h = setup();
    h.host.reviewLifecycle = finishRun(h.host.reviewLifecycle, {
      reason: "error",
      report: "boom",
      at: 1,
    });
    dismissSession(h.ctx, cmd({ type: "dismiss_session", expectedLifecycleRevision: 0 }), h.ws);
    expect(h.host.reviewLifecycle).toMatchObject({
      reviewState: "error_to_review",
      dismissedAt: expect.any(Number),
      lifecycleRevision: 2,
    });
    expect(h.wsSent.at(-1)?.["success"]).toBe(true);
  });

  it("retains revision conflict protection when restoring dismissed history", () => {
    const h = setup();
    dismissSession(h.ctx, cmd({ type: "dismiss_session", expectedLifecycleRevision: 0 }), h.ws);
    reopenSession(h.ctx, cmd({ type: "reopen_session", expectedLifecycleRevision: 0 }), h.ws);
    expect(h.host.reviewLifecycle.dismissedAt).not.toBeNull();
    expect(h.wsSent.at(-1)).toMatchObject({
      success: false,
      code: "LIFECYCLE_REVISION_CONFLICT",
    });
  });

  it("makes repeated commands idempotent even with a stale revision", () => {
    const h = setup();
    dismissSession(h.ctx, cmd({ type: "dismiss_session", expectedLifecycleRevision: 0 }), h.ws);
    const revision = h.host.reviewLifecycle.lifecycleRevision;
    dismissSession(h.ctx, cmd({ type: "dismiss_session", expectedLifecycleRevision: 0 }), h.ws);
    expect(h.host.reviewLifecycle.lifecycleRevision).toBe(revision);
    expect(h.wsSent.at(-1)?.["success"]).toBe(true);
  });
});
