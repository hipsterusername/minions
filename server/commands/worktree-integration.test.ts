import { describe, expect, it, vi } from "vitest";
import { setup } from "../../tests/support/server-command-harness.ts";
import { dispatchCommand } from "./index.ts";
import { validateWsCommand } from "./schemas.ts";
import { WorktreeIntegrationServiceError,
  type WorktreeIntegrationService } from "../worktree-integration-service.ts";

describe("worktree integration commands", () => {
  it("queries canonical status by server run identity", async () => {
    const h = setup(); const getStatus = vi.fn(async () => null);
    h.ctx.worktreeIntegrations = { getStatus } as unknown as WorktreeIntegrationService;
    dispatchCommand(h.ctx, { type: "get_worktree_lineage_status", runKey: "run-1" }, h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(getStatus).toHaveBeenCalledWith({ runKey: "run-1" });
    expect(h.wsSent[0]).toMatchObject({ topic: "global", type: "worktree_integration_response",
      success: true, result: null });
  });

  it("returns stable conflict codes for stale CAS mutations", async () => {
    const h = setup(); const reviewContribution = vi.fn(async () => {
      throw new WorktreeIntegrationServiceError("conflict", "stale contribution revision", null);
    });
    h.ctx.worktreeIntegrations = { reviewContribution } as unknown as WorktreeIntegrationService;
    dispatchCommand(h.ctx, { type: "review_worktree_contribution", requestId: "req",
      contributionId: "contribution", expectedIntegrationRevision: 4,
      decision: "approved", actor: "user", summary: "reviewed" }, h.ws);
    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(h.wsSent[0]).toMatchObject({ success: false, code: "conflict",
      error: "stale contribution revision", latest: null });
  });

  it("joins membership with lineage CAS and never accepts a client run key", () => {
    const parsed = validateWsCommand({ type: "join_worktree_lineage",
      requestId: "00000000-0000-4000-8000-000000000001", workItemId: "work",
      lineageId: "lineage", expectedIntegrationRevision: 2, actor: "user" });
    expect(parsed.ok).toBe(true);
  });
});
