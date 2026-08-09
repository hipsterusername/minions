import { describe, expect, it, vi } from "vitest";
import { setup } from "../support/server-command-harness.ts";
import { dispatchCommand } from "../../server/commands/index.ts";
import { worktreeLineageSnapshotSchema,
  type WorktreeLineageSnapshot } from "../../shared/worktree-integration.ts";
import type { WorktreeIntegrationService } from "../../server/worktree-integration-service.ts";

function makeSnapshot(id: string): WorktreeLineageSnapshot {
  return {
    id, projectId: "proj-1", repositoryPath: "/repo",
    targetRef: "refs/heads/main", baseSha: "a".repeat(40),
    integrationRef: `refs/heads/minions/integration/${id}`,
    integrationWorktreePath: `/repo/.canvas-worktrees/integration-${id}`,
    integrationHeadSha: null, revision: 0,
    integrationState: "active", status: "open",
    memberships: [], resolutionRuns: [], contributions: [],
    queue: [], gates: [], reviews: [],
    createdAt: 1, updatedAt: 2,
  };
}

describe("list_worktree_lineages command", () => {
  it("unicasts every lineage snapshot as a worktree_lineages_list envelope", async () => {
    const h = setup();
    const listLineages = vi.fn(async () => [makeSnapshot("lineage-1"), makeSnapshot("lineage-2")]);
    h.ctx.worktreeIntegrations = { listLineages } as unknown as WorktreeIntegrationService;

    dispatchCommand(h.ctx, { type: "list_worktree_lineages", requestId: "req-1" }, h.ws);

    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(listLineages).toHaveBeenCalledOnce();
    const payload = h.wsSent[0];
    expect(payload).toMatchObject({ topic: "global", type: "worktree_lineages_list", requestId: "req-1" });
    const lineages = payload["lineages"] as unknown[];
    expect(lineages).toHaveLength(2);
    for (const lineage of lineages) {
      expect(worktreeLineageSnapshotSchema.safeParse(lineage).success).toBe(true);
    }
    expect(payload["error"]).toBeUndefined();
  });

  it("returns an empty list plus an error when the service is unavailable", async () => {
    const h = setup();
    h.ctx.worktreeIntegrations = undefined;

    dispatchCommand(h.ctx, { type: "list_worktree_lineages", requestId: "req-2" }, h.ws);

    await vi.waitFor(() => expect(h.wsSent).toHaveLength(1));
    expect(h.wsSent[0]).toMatchObject({ type: "worktree_lineages_list", requestId: "req-2",
      lineages: [], error: "Integration service unavailable" });
  });
});
