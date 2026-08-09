/**
 * Tests for WorktreeIntegrationControls — the progressive-disclosure container
 * that wires View 1 (LineageNodeStrip, inline) to Views 2+3 (LineageModal).
 *
 * Covers:
 *   - renders the inline strip collapsed (no modal) by default
 *   - the expand affordance opens the modal (View 2/3), which defaults to the
 *     "This lineage" tab and exposes the "All lineages" big-picture tab
 *   - closing the modal collapses back to just the strip
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorktreeIntegrationControls } from "./WorktreeIntegrationControls.tsx";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";

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

describe("<WorktreeIntegrationControls />", () => {
  it("renders the inline strip collapsed with no modal by default", () => {
    render(
      <WorktreeIntegrationControls
        lineage={lineage()}
        workItemId="work-1"
        runKey="run-1"
        send={vi.fn()}
      />,
    );
    expect(screen.getByTestId("lineage-node-strip")).toBeInTheDocument();
    // Modal head is not mounted until expanded.
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("All lineages")).not.toBeInTheDocument();
  });

  it("expands into the modal and collapses back on close", () => {
    render(
      <WorktreeIntegrationControls
        lineage={lineage()}
        workItemId="work-1"
        runKey="run-1"
        send={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand lineage" }));

    // View 2/3 modal is now open with both tabs available.
    expect(
      screen.getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
    expect(screen.getByText("This lineage")).toBeInTheDocument();
    expect(screen.getByText(/All lineages/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // Back to just the collapsed strip.
    expect(screen.getByTestId("lineage-node-strip")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
  });
});
