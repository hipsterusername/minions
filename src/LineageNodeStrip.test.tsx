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
import { act, render, screen, fireEvent } from "@testing-library/react";
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

  it("shows explicit contribution review actions and approves with the right payload", () => {
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

    const approve = screen.getByRole("button", { name: "✓ Approve contribution" });
    expect(screen.getByRole("button", { name: "↶ Request changes" })).toBeInTheDocument();

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

  it("hides review actions when the contribution is not ready+pending", () => {
    const { rerender } = render(
      <LineageNodeStrip
        lineage={lineage()}
        contribution={contribution({ reviewState: "approved" })}
        send={vi.fn()}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "✓ Approve contribution" })).toBeNull();
    expect(screen.queryByRole("button", { name: "↶ Request changes" })).toBeNull();

    rerender(
      <LineageNodeStrip
        lineage={lineage()}
        contribution={contribution({ state: "active", reviewState: "pending" })}
        send={vi.fn()}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "✓ Approve contribution" })).toBeNull();
    expect(screen.queryByRole("button", { name: "↶ Request changes" })).toBeNull();
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


describe("review receipts", () => {
  it("preserves gate rejection correlation after a revision render and protects the next intent", () => {
    let receive: (message: unknown) => void = () => {};
    const subscribe = (fn: (message: unknown) => void) => { receive = fn; return () => {}; };
    const send = vi.fn();
    const props = { lineage: lineage(), send, subscribe, onExpand: vi.fn() };
    const { rerender } = render(<LineageNodeStrip {...props} contribution={contribution()} />);
    fireEvent.click(screen.getByRole("button", { name: "✓ Approve contribution" }));
    const firstId = send.mock.calls[0]![0].requestId;
    rerender(<LineageNodeStrip {...props} contribution={contribution({ revision: 8 })} />);
    const failure = { type: "worktree_integration_response", command: "review_worktree_contribution",
      requestId: firstId, success: false, code: "gate_failed", error: "contribution gates failed" };
    act(() => receive(failure));
    expect(screen.getByText("contribution gates failed", { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "✓ Approve contribution" }));
    expect(send.mock.calls.at(-1)![0].expectedIntegrationRevision).toBe(8);
    const secondId = send.mock.calls.at(-1)![0].requestId;
    expect(secondId).not.toBe(firstId);
    act(() => receive(failure));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Recording approval…" })).toBeDisabled();
    rerender(<LineageNodeStrip {...props} contribution={contribution({ revision: 9 })} />);
    fireEvent.click(screen.getByRole("button", { name: "↶ Request changes" }));
    act(() => receive({ ...failure, requestId: secondId }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Recording request…" })).toBeDisabled();
  });
  it("locks conflicting actions, ignores unrelated receipts, and recovers rejection", () => {
    let receive: (message: unknown) => void = () => {};
    const subscribe = (fn: (message: unknown) => void) => { receive = fn; return () => {}; };
    const send = vi.fn();
    render(<LineageNodeStrip lineage={lineage()} contribution={contribution()} send={send} subscribe={subscribe} onExpand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✓ Approve contribution" }));
    fireEvent.click(screen.getByRole("button", { name: "Recording approval…" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "↶ Request changes" })).toBeDisabled();
    const requestId = send.mock.calls[0]![0].requestId;
    act(() => receive({ type: "worktree_integration_response", command: "review_worktree_contribution", requestId: "other", success: true }));
    expect(screen.getByRole("button", { name: "Recording approval…" })).toBeDisabled();
    act(() => receive({ type: "worktree_integration_response", command: "review_worktree_contribution", requestId, success: false, code: "conflict", error: "stale", latest: lineage({ contributions: [contribution({ revision: 8 })] }) }));
    expect(screen.getByRole("alert")).toHaveTextContent("Changes updated. Review again.");
    fireEvent.click(screen.getByRole("button", { name: "✓ Approve contribution" }));
    expect(send.mock.calls.at(-1)![0].expectedIntegrationRevision).toBe(8);
    act(() => receive({ type: "worktree_integration_response", command: "review_worktree_contribution", requestId: send.mock.calls.at(-1)![0].requestId, success: true, result: lineage({ contributions: [contribution({ revision: 9, reviewState: "approved", state: "queued" })] }) }));
    expect(screen.getByText("Approved · awaiting integration")).toBeVisible();
    expect(screen.queryByText("integrated")).toBeNull();
  });
  it("reconciles an unconfirmed review after reconnect without resending it", () => {
    let receive: (message: unknown) => void = () => {};
    const subscribe = (fn: (message: unknown) => void) => { receive = fn; return () => {}; };
    const send = vi.fn();
    render(<LineageNodeStrip lineage={lineage()} contribution={contribution()} send={send} subscribe={subscribe} onExpand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "↶ Request changes" }));
    act(() => receive({ type: "socket_reconnected" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Review not confirmed after reconnect");
    expect(screen.getByRole("button", { name: "Recording request…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh review status" }));
    const command = send.mock.calls.at(-1)![0];
    expect(command.type).toBe("get_worktree_lineage_status");
    act(() => receive({ type: "worktree_integration_response", command: command.type, requestId: command.requestId, success: true, result: lineage({ contributions: [contribution()] }) }));
    expect(screen.getByRole("button", { name: "↶ Request changes" })).toBeEnabled();
    expect(send.mock.calls.filter(([message]) => message.type === "review_worktree_contribution")).toHaveLength(1);
  });

  it("shows integration only from the authoritative contribution state", () => {
    const props = { lineage: lineage(), send: vi.fn(), onExpand: vi.fn() };
    const { rerender } = render(<LineageNodeStrip {...props} contribution={contribution({ reviewState: "approved", state: "queued" })} />);
    expect(screen.getByText("Approved · awaiting integration")).toBeVisible();
    rerender(<LineageNodeStrip {...props} contribution={contribution({ reviewState: "approved", state: "integrated", revision: 8 })} />);
    expect(screen.getByText("Approved · contribution integrated")).toBeVisible();
    rerender(<LineageNodeStrip {...props} contribution={contribution({ reviewState: "approved", state: "discarded", revision: 9 })} />);
    expect(screen.queryByText("Approved · awaiting integration")).toBeNull();
  });

});
