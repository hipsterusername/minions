/**
 * Tests for LineageNodeStrip — View 1 ("in-action") of the lineage redesign.
 *
 * Covers:
 *   - renders the short lineage id + integration state
 *   - Approve/Reject shown only for a ready+pending contribution, and Approve
 *     emits the correct review command
 *   - Approve/Reject hidden when reviewState !== pending or state !== ready
 *   - the expand affordance calls onExpand
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LineageNodeStrip } from "./LineageNodeStrip.tsx";
import type {
  WorktreeContributionSnapshot,
  WorktreeLineageSnapshot,
} from "../shared/worktree-integration.ts";

function lineage(
  overrides: Partial<WorktreeLineageSnapshot> = {},
): WorktreeLineageSnapshot {
  return {
    id: "lineage-abcdef012345-tail",
    projectId: "proj-1",
    repositoryPath: "/repo",
    targetRef: "main",
    baseSha: "base000",
    integrationRef: "refs/int/lineage",
    integrationWorktreePath: "/repo/.int",
    integrationHeadSha: null,
    revision: 3,
    integrationState: "active",
    status: "open",
    memberships: [],
    resolutionRuns: [],
    contributions: [],
    queue: [],
    gates: [],
    reviews: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function contribution(
  overrides: Partial<WorktreeContributionSnapshot> = {},
): WorktreeContributionSnapshot {
  return {
    id: "contrib-1",
    lineageId: "lineage-abcdef012345-tail",
    workItemId: "work-1",
    originatingRunKey: "run-1",
    runKeys: ["run-1"],
    branchName: "feat/x",
    worktreePath: "/repo/.wt",
    baseSha: "base000",
    headSha: "abcdef1234567890",
    revision: 7,
    state: "ready",
    reviewState: "pending",
    cleanupState: "retained",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("<LineageNodeStrip />", () => {
  it("renders the short lineage id and integration state", () => {
    render(
      <LineageNodeStrip
        lineage={lineage({ integrationState: "queued" })}
        contribution={null}
        send={vi.fn()}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText("lineage-abcd…")).toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(screen.getByText("No contribution yet")).toBeInTheDocument();
  });

  it("shows Approve/Reject for a ready+pending contribution and approves with the right payload", () => {
    const send = vi.fn();
    const contrib = contribution({ id: "contrib-9", revision: 12 });
    render(
      <LineageNodeStrip
        lineage={lineage()}
        contribution={contrib}
        send={send}
        onExpand={vi.fn()}
      />,
    );

    const approve = screen.getByRole("button", { name: "✓ Approve" });
    expect(screen.getByRole("button", { name: "✕ Reject" })).toBeInTheDocument();

    fireEvent.click(approve);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "review_worktree_contribution",
        decision: "approved",
        contributionId: "contrib-9",
        expectedIntegrationRevision: 12,
      }),
    );
  });

  it("hides Approve/Reject when the contribution is not ready+pending", () => {
    const { rerender } = render(
      <LineageNodeStrip
        lineage={lineage()}
        contribution={contribution({ reviewState: "approved" })}
        send={vi.fn()}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "✓ Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "✕ Reject" })).toBeNull();

    rerender(
      <LineageNodeStrip
        lineage={lineage()}
        contribution={contribution({ state: "active", reviewState: "pending" })}
        send={vi.fn()}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "✓ Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "✕ Reject" })).toBeNull();
  });

  it("calls onExpand when the expand button is clicked", () => {
    const onExpand = vi.fn();
    render(
      <LineageNodeStrip
        lineage={lineage()}
        contribution={null}
        send={vi.fn()}
        onExpand={onExpand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand lineage" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
