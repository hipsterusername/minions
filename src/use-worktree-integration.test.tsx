import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import { WorktreeIntegrationControls } from "./WorktreeIntegrationControls.tsx";
import { mergeWorktreeIntegrationSnapshot, selectWorktreeContribution,
  useWorktreeIntegration } from "./use-worktree-integration.ts";

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

describe("WorktreeIntegrationControls", () => {
  it("visualizes each leader contribution flowing into the combined lineage and target", () => {
    render(<WorktreeIntegrationControls lineage={snapshot({ contributions: [
      { ...snapshot().contributions[0]!, state: "integrated" },
      { ...snapshot().contributions[0]!, id: "contrib-2", workItemId: "work-2",
        originatingRunKey: "run-2", runKeys: ["run-2", "run-3"],
        branchName: "minions/contribution/two", state: "discarded" },
    ] })} workItemId="work-1" runKey="run-1" send={vi.fn()} />);
    const map = screen.getByRole("region", { name: "Combined lineage map" });
    expect(map).toHaveTextContent("This leader");
    expect(map).toHaveTextContent("Leader work-2");
    expect(map).toHaveTextContent("Combined lineage");
    expect(map).toHaveTextContent("Target");
    expect(map).toHaveTextContent("1 integrated · 0 pending · 1 discarded");
    expect(map).toHaveTextContent("Set before the first worktree run");
  });

  it("explains approve, reject, discard, and new-iteration semantics", () => {
    render(<WorktreeIntegrationControls lineage={snapshot()} workItemId="work-1"
      runKey="run-1" send={vi.fn()} />);
    const guide = screen.getByRole("group", { name: "Contribution decision guide" });
    expect(guide).toHaveTextContent("Accept this exact contribution head");
    expect(guide).toHaveTextContent("Keep the contribution and worktree");
    expect(guide).toHaveTextContent("Terminally exclude this contribution");
    expect(guide).toHaveTextContent("Reuses the same contribution branch/worktree");
  });

  it("keeps contribution approval and enqueue as separate user actions", () => {
    const send = vi.fn();
    const { rerender } = render(<WorktreeIntegrationControls lineage={snapshot()}
      workItemId="work-1" runKey="run-1" send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve contribution" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "review_worktree_contribution" }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "enqueue_worktree_contribution" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject contribution" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "review_worktree_contribution",
      decision: "rejected" }));

    rerender(<WorktreeIntegrationControls lineage={snapshot({ contributions: [{
      ...snapshot().contributions[0]!, reviewState: "approved",
    }] })} workItemId="work-1" runKey="run-1" send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "Enqueue contribution" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "enqueue_worktree_contribution" }));
  });

  it("blocks approval on pending gates and guides conflicts into a new iteration", () => {
    render(<WorktreeIntegrationControls lineage={snapshot({
      integrationState: "conflicted",
      contributions: [{ ...snapshot().contributions[0]!, state: "conflicted" }],
      gates: [{ id: "gate-1", lineageId: "lineage-1", contributionId: "contrib-1",
        scope: "contribution", name: "tests", status: "pending", details: null, recordedAt: 4 }],
    })} workItemId="work-1" runKey="run-1" send={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Start a new iteration");
    expect(screen.queryByRole("button", { name: "Retry contribution" })).toBeNull();
    expect(screen.getByText("tests: pending")).toBeInTheDocument();
  });

  it("keeps final review and promotion as separate user actions", () => {
    const send = vi.fn();
    const integrated = { ...snapshot().contributions[0]!, state: "integrated" as const,
      reviewState: "approved" as const };
    const { rerender } = render(<WorktreeIntegrationControls lineage={snapshot({
      integrationHeadSha: "combined", contributions: [integrated],
    })} workItemId="work-1" send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve combined lineage" }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "promote_worktree_lineage" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject combined lineage" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "review_worktree_lineage",
      decision: "rejected" }));
    rerender(<WorktreeIntegrationControls lineage={snapshot({ integrationHeadSha: "combined",
      contributions: [integrated], reviews: [{ id: "review-1", lineageId: "lineage-1",
        contributionId: null, scope: "lineage", decision: "approved", actor: "user", notes: null,
        reviewedHeadSha: "combined", recordedAt: 5 }] })} workItemId="work-1" send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to main" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "promote_worktree_lineage" }));
    rerender(<WorktreeIntegrationControls lineage={snapshot({ integrationHeadSha: "combined",
      contributions: [integrated], reviews: [
        { id: "review-1", lineageId: "lineage-1", contributionId: null, scope: "lineage",
          decision: "approved", actor: "user", notes: null, reviewedHeadSha: "combined", recordedAt: 5 },
        { id: "review-2", lineageId: "lineage-1", contributionId: null, scope: "lineage",
          decision: "rejected", actor: "user", notes: null, reviewedHeadSha: "combined", recordedAt: 5 },
      ] })} workItemId="work-1" send={send} />);
    expect(screen.queryByRole("button", { name: "Promote to main" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve combined lineage" })).toBeInTheDocument();
  });

  it("does not offer final review while promotion is conflicted and renders preserved paths", () => {
    const integrated = { ...snapshot().contributions[0]!, state: "integrated" as const };
    render(<WorktreeIntegrationControls lineage={snapshot({ integrationState: "conflicted",
      contributions: [integrated], queue: [{ id: "queue-1", lineageId: "lineage-1",
        contributionId: null, kind: "lineage", repositoryPath: "/repo", targetRef: "main",
        expectedSourceSha: "head", expectedTargetSha: "base", state: "conflicted", revision: 2,
        attempt: 1, workerId: null, resultSha: null, fencingToken: 1, error: "merge conflict",
        conflictDetails: { conflicts: ["src/a.ts"], preservedPaths: ["/repo/.worktrees/integration"],
          targetSha: "base", sourceSha: "head" }, position: null, enqueuedAt: 2, startedAt: 3,
        finishedAt: 4, updatedAt: 4 }] })} workItemId="work-1" send={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Approve combined lineage" })).toBeNull();
    expect(screen.getByText(/src\/a.ts/)).toBeInTheDocument();
    expect(screen.getByText(/\.worktrees\/integration/)).toBeInTheDocument();
  });
});
