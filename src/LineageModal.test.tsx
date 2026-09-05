/**
 * Tests for <LineageModal /> — Views 2 & 3 of the lineage redesign.
 *
 * Covers:
 *   - tab rendering + switching between "This lineage" and "All lineages"
 *   - contribution row selection revealing the approve action + its payload
 *   - the all-lineages list + map-to-lineage join command
 *   - backdrop / close button / Escape all invoking onClose
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { LineageModal } from "./LineageModal.tsx";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";

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

function renderModal(props: Partial<Parameters<typeof LineageModal>[0]> = {}) {
  const send = props.send ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const lineage = props.lineage ?? snapshot();
  render(
    <LineageModal
      lineage={lineage}
      workItemId={props.workItemId ?? "work-1"}
      runKey={props.runKey ?? "run-1"}
      allLineages={props.allLineages ?? [lineage]}
      send={send}
      onClose={onClose}
    />,
  );
  return { send, onClose, lineage };
}

function renderModalRerender(props: Partial<Parameters<typeof LineageModal>[0]> = {}) {
  const send = props.send ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const lineage = props.lineage ?? snapshot();
  const element = (next: WorktreeLineageSnapshot) => (
    <LineageModal
      lineage={next}
      workItemId={props.workItemId ?? "work-1"}
      runKey={props.runKey ?? "run-1"}
      allLineages={props.allLineages ?? [next]}
      send={send}
      onClose={onClose}
    />
  );
  const view = render(element(lineage));
  return { send, onClose, rerender: (next: WorktreeLineageSnapshot) => view.rerender(element(next)) };
}

describe("<LineageModal />", () => {
  it("renders both tabs and switches to All lineages on click", () => {
    renderModal({ allLineages: [snapshot(), snapshot({ id: "lineage-2" })] });
    expect(screen.getByRole("button", { name: /This lineage/ })).toBeInTheDocument();
    const allTab = screen.getByRole("button", { name: /All lineages/ });
    expect(allTab).toBeInTheDocument();

    // This-lineage content is visible first, map block is not.
    expect(screen.queryByRole("button", { name: "Map" })).toBeNull();
    fireEvent.click(allTab);
    expect(screen.getByRole("button", { name: "Map" })).toBeInTheDocument();
    expect(screen.getByText("Map this leader to an active lineage")).toBeInTheDocument();
  });

  it("reveals Approve when a ready+pending contribution row is selected and sends the review", () => {
    const { send } = renderModal();
    // Not visible until the row is expanded.
    expect(screen.queryByRole("button", { name: "Approve contribution" })).toBeNull();

    fireEvent.click(screen.getByText("This leader"));
    fireEvent.click(screen.getByRole("button", { name: "Approve contribution" }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "review_worktree_contribution",
      contributionId: "contrib-1",
      expectedIntegrationRevision: 2,
      decision: "approved",
    }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "enqueue_worktree_contribution",
    }));
  });

  it("lists all lineages, marks the current one, and maps to a chosen open lineage", () => {
    const current = snapshot({ id: "lineage-1" });
    const other = snapshot({ id: "lineage-2", revision: 7, status: "open",
      contributions: [], memberships: [] });
    const closed = snapshot({ id: "lineage-3", status: "integrated" });
    const { send } = renderModal({ lineage: current,
      allLineages: [current, other, closed] });

    fireEvent.click(screen.getByRole("button", { name: /All lineages/ }));

    const currentItem = screen.getByText("current").closest(".lin3-item")!;
    expect(within(currentItem as HTMLElement).getByText(/lineage-1/)).toBeInTheDocument();
    // All three lineages listed (scope to the list — ids also appear in the select).
    const list = document.querySelector(".lin3-list") as HTMLElement;
    expect(within(list).getByText(/lineage-2/)).toBeInTheDocument();
    expect(within(list).getByText(/lineage-3/)).toBeInTheDocument();

    // Only open, non-current lineages are map candidates (lineage-2, not lineage-3).
    const select = screen.getByRole("combobox", { name: "Target lineage" }) as HTMLSelectElement;
    expect(within(select).queryByText(/lineage-3/)).toBeNull();
    fireEvent.change(select, { target: { value: "lineage-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Map" }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "join_worktree_lineage",
      workItemId: "work-1",
      lineageId: "lineage-2",
      expectedIntegrationRevision: 7,
      actor: "user",
    }));
  });

  it("keeps contribution approval and enqueue as separate actions in the row detail", () => {
    // A ready+approved contribution offers Enqueue (not Approve) once the row is open.
    const { send } = renderModal({
      lineage: snapshot({
        contributions: [{ ...snapshot().contributions[0]!, reviewState: "approved" }],
      }),
    });
    fireEvent.click(screen.getByText("This leader"));
    expect(screen.queryByRole("button", { name: "Approve contribution" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enqueue contribution" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "enqueue_worktree_contribution",
      contributionId: "contrib-1",
      expectedIntegrationRevision: 2,
    }));
  });

  it("surfaces conflict recovery and blocks approval on pending gates", () => {
    renderModal({
      lineage: snapshot({
        integrationState: "conflicted",
        contributions: [{ ...snapshot().contributions[0]!, state: "conflicted" }],
        gates: [{ id: "gate-1", lineageId: "lineage-1", contributionId: "contrib-1",
          scope: "contribution", name: "tests", status: "pending", details: null,
          recordedAt: 4 }],
      }),
    });
    // Lineage-level promotion conflict is shown at the tab head.
    expect(screen.getByRole("alert")).toHaveTextContent("Promotion needs another review");

    fireEvent.click(screen.getByText("This leader"));
    // Contribution-level guidance + the blocking gate are shown; a conflicted
    // contribution offers neither Approve nor Retry.
    expect(screen.getByText(/Start a new iteration/)).toBeInTheDocument();
    expect(screen.getByText("tests: pending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve contribution" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry contribution" })).toBeNull();
  });

  it("keeps final review and promotion as separate actions", () => {
    const integrated = { ...snapshot().contributions[0]!, state: "integrated" as const,
      reviewState: "approved" as const };
    const review = { id: "review-1", lineageId: "lineage-1", contributionId: null,
      scope: "lineage" as const, decision: "approved" as const, actor: "user", notes: null,
      reviewedHeadSha: "combined", recordedAt: 5 };

    // Pending final review: Approve/Reject combined, but no Promote yet.
    const { send, rerender } = renderModalRerender({
      lineage: snapshot({ integrationHeadSha: "combined", contributions: [integrated] }),
    });
    fireEvent.click(screen.getByText("This leader"));
    fireEvent.click(screen.getByRole("button", { name: "Approve combined lineage" }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "promote_worktree_lineage" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "review_worktree_lineage", decision: "approved" }));

    // Once the combined head is approved, Promote appears as a distinct action
    // in the already-open row detail.
    rerender(snapshot({ integrationHeadSha: "combined", contributions: [integrated],
      reviews: [review] }));
    fireEvent.click(screen.getByRole("button", { name: "Promote to main" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "promote_worktree_lineage" }));
  });

  it("hides final review and shows preserved paths while promotion is conflicted", () => {
    const integrated = { ...snapshot().contributions[0]!, state: "integrated" as const };
    renderModal({
      lineage: snapshot({ integrationState: "conflicted", contributions: [integrated],
        queue: [{ id: "queue-1", lineageId: "lineage-1", contributionId: null,
          kind: "lineage", repositoryPath: "/repo", targetRef: "main",
          expectedSourceSha: "head", expectedTargetSha: "base", state: "conflicted",
          revision: 2, attempt: 1, workerId: null, resultSha: null, fencingToken: 1,
          error: "merge conflict",
          conflictDetails: { conflicts: ["src/a.ts"],
            preservedPaths: ["/repo/.worktrees/integration"], targetSha: "base",
            sourceSha: "head" }, position: null, enqueuedAt: 2, startedAt: 3,
          finishedAt: 4, updatedAt: 4 }] }),
    });
    // Promotion needs another review blocks final review even before selecting a row.
    expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/\.worktrees\/integration/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("This leader"));
    expect(screen.queryByRole("button", { name: "Approve combined lineage" })).toBeNull();
  });

  it("calls onClose from the backdrop, the close button, and Escape", () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    // The backdrop is the outermost element; clicking it (not the inner modal) closes.
    const backdrop = document.querySelector(".lin-modal__backdrop")!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

it("lets review refresh pending gates while integration stays blocked", () => {
  const { send } = renderModal({ lineage: snapshot({ gates: [{ id: "gate", lineageId: "lineage-1",
    contributionId: "contrib-1", scope: "contribution", name: "tests", status: "pending", details: null, recordedAt: 1 }] }) });
  fireEvent.click(screen.getByText("This leader"));
  const review = screen.getByRole("button", { name: "Approve contribution" });
  expect(review).toBeEnabled(); fireEvent.click(review);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "review_worktree_contribution" }));
  expect(screen.queryByRole("button", { name: "Enqueue contribution" })).toBeNull();
});
