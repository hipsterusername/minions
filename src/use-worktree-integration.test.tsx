import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import { mergeWorktreeIntegrationSnapshot, selectLatestLineageReview, selectLatestQueueEntry,
  selectWorktreeContribution, useWorktreeIntegration } from "./use-worktree-integration.ts";

function snapshot(overrides: Partial<WorktreeLineageSnapshot> = {}): WorktreeLineageSnapshot {
  return {
    id: "lineage-1", projectId: "project-1", repositoryPath: "/repo", targetRef: "main",
    baseSha: "base", integrationRef: "refs/minions/integration/1",
    integrationWorktreePath: "/repo/.worktrees/integration", integrationHeadSha: "head",
    revision: 3, integrationState: "active", status: "open",
    memberships: [{ workItemId: "work-1", status: "active", revision: 1, actor: "user",
      joinedAt: 1, leftAt: null }],
    resolutionRuns: [],
    contributions: [{ id: "contrib-1", lineageId: "lineage-1", workItemId: "work-1",
      originatingRunKey: "run-1", runKeys: ["run-1"], branchName: "feature",
      worktreePath: "/repo/.worktrees/feature", baseSha: "base", headSha: "head",
      revision: 2, state: "ready", reviewState: "pending", cleanupState: "retained",
      createdAt: 1, updatedAt: 2 }],
    queue: [], gates: [], reviews: [], createdAt: 1, updatedAt: 3, ...overrides,
  };
}

describe("worktree integration client state", () => {
  it("does not roll a contribution back when an older lineage response arrives", () => {
    const current = snapshot({ revision: 4, contributions: [{ ...snapshot().contributions[0]!,
      revision: 5, state: "queued" }] });
    const merged = mergeWorktreeIntegrationSnapshot(current, snapshot({ revision: 3 }));
    expect(merged.revision).toBe(4);
    expect(merged.contributions[0]?.state).toBe("queued");
  });

  it("selects a resolution run through the durable contribution run membership", () => {
    const lineage = snapshot({ resolutionRuns: [{ lineageId: "lineage-1", runKey: "resolution-run",
      workItemId: "work-1", state: "active", revision: 1, headSha: null, error: null,
      startedAt: 4, finishedAt: null }] });
    expect(selectWorktreeContribution(lineage, { workItemId: "work-1", runKey: "resolution-run" })?.id)
      .toBe("contrib-1");
  });

  it("selects current queue and review records independently of snapshot array order", () => {
    const queue = (id: string, updatedAt: number): WorktreeLineageSnapshot["queue"][number] => ({
      id, lineageId: "lineage-1", contributionId: "contrib-1", kind: "contribution",
      repositoryPath: "/repo", targetRef: "main", expectedSourceSha: "head",
      expectedTargetSha: "base", state: updatedAt === 9 ? "running" : "failed", revision: 1,
      attempt: 1, workerId: null, resultSha: null, fencingToken: 1, error: null,
      conflictDetails: null, position: null, enqueuedAt: updatedAt, startedAt: null,
      finishedAt: null, updatedAt,
    });
    const review = (id: string, recordedAt: number, decision: "approved" | "rejected") => ({
      id, lineageId: "lineage-1", contributionId: null, scope: "lineage" as const,
      decision, actor: "user", notes: null, reviewedHeadSha: "head", recordedAt,
    });
    const lineage = snapshot({
      queue: [queue("new-queue", 9), queue("old-queue", 4)],
      reviews: [review("new-review", 9, "rejected"), review("old-review", 4, "approved")],
    });

    expect(selectLatestQueueEntry(lineage, (entry) => entry.contributionId === "contrib-1")?.id)
      .toBe("new-queue");
    expect(selectLatestLineageReview(lineage)?.decision).toBe("rejected");
  });

  it("consumes successful mutation responses even when a changed event is missed", () => {
    const listeners = new Set<(message: unknown) => void>();
    const subscribe = (listener: (message: unknown) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    };
    const send = vi.fn();
    function Probe() {
      const state = useWorktreeIntegration({ workItemId: "work-1", send, subscribe });
      return <span>{state.lineage?.integrationState ?? "missing"}</span>;
    }
    render(<Probe />);
    expect(send).toHaveBeenCalledWith({ type: "get_worktree_lineage_status", workItemId: "work-1" });
    act(() => { for (const listener of listeners) listener({ type: "worktree_integration_response",
      command: "enqueue_worktree_contribution", requestId: "request-1", success: true,
      result: snapshot({ integrationState: "queued", revision: 4 }) }); });
    expect(screen.getByText("queued")).toBeInTheDocument();
    act(() => { for (const listener of listeners) listener({ type: "worktree_integration_changed",
      operation: "promoted", workItemId: "work-1", timestamp: 8,
      lineage: snapshot({ integrationState: "integrated", status: "integrated", revision: 5,
        memberships: [{ ...snapshot().memberships[0]!, status: "left", revision: 2, leftAt: 8 }] }) }); });
    expect(screen.getByText("integrated")).toBeInTheDocument();
  });
});
