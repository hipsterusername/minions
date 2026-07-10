/**
 * Tests for the worktree review helpers + inline panel (folded into Activity).
 *
 * Covers:
 *   - leaderHasReviewableChanges predicate across worktree states
 *   - countReviewableLeaders filtering
 *   - SessionChangesPanel: diff fetch on mount, merge/discard commands,
 *     and the conflict deep-link to canvas
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  SessionChangesPanel,
  countReviewableLeaders,
  leaderHasReviewableChanges,
} from "./ChangesView.tsx";
import { LEADER_DEFAULT_DATA, type LeaderData } from "./nodes/leader/types.ts";
import type { CanvasNode } from "./types.ts";

function leaderData(overrides: Partial<LeaderData>): LeaderData {
  return { ...LEADER_DEFAULT_DATA, ...overrides };
}

function leaderNode(id: string, data: Partial<LeaderData>): CanvasNode {
  return {
    id,
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    data: leaderData(data),
  };
}

function renderPanel(data: Partial<LeaderData>, extra?: {
  send?: (d: unknown) => void;
  onUpdate?: (id: string, d: LeaderData) => void;
  onOpen?: (id: string) => void;
}) {
  const full = leaderData({ sessionKey: "s1", worktreeStatus: "active", ...data });
  return render(
    <SessionChangesPanel
      nodeId="l1"
      sessionKey={full.sessionKey as string}
      data={full}
      socketSend={extra?.send ?? vi.fn()}
      socketSubscribe={vi.fn(() => () => {})}
      onUpdateNodeData={extra?.onUpdate ?? vi.fn()}
      onOpenInCanvas={extra?.onOpen ?? vi.fn()}
    />,
  );
}

describe("leaderHasReviewableChanges", () => {
  it("is false without a session key", () => {
    expect(leaderHasReviewableChanges(leaderData({ worktreeStatus: "active" }))).toBe(false);
  });

  it("is true for an active isolated worktree", () => {
    expect(
      leaderHasReviewableChanges(leaderData({ sessionKey: "s1", worktreeStatus: "active" })),
    ).toBe(true);
  });

  it("is true when approval is pending even if status is none", () => {
    expect(
      leaderHasReviewableChanges(
        leaderData({ sessionKey: "s1", worktreeStatus: "none", approvalPending: true }),
      ),
    ).toBe(true);
  });

  it("is true when there is a merge conflict", () => {
    expect(
      leaderHasReviewableChanges(
        leaderData({
          sessionKey: "s1",
          worktreeStatus: "none",
          mergeConflict: { conflicts: ["a.ts"], summary: "", targetBranch: "main" },
        }),
      ),
    ).toBe(true);
  });

  it("is false for merged / discarded / creating / none states", () => {
    for (const s of ["merged", "discarded", "creating", "none"] as const) {
      expect(
        leaderHasReviewableChanges(leaderData({ sessionKey: "s1", worktreeStatus: s })),
      ).toBe(false);
    }
  });
});

describe("countReviewableLeaders", () => {
  it("counts only reviewable leader nodes and ignores other types", () => {
    const nodes: CanvasNode[] = [
      leaderNode("l1", { sessionKey: "s1", worktreeStatus: "active" }),
      leaderNode("l2", { sessionKey: "s2", worktreeStatus: "merged" }),
      { id: "m1", type: "markdown", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {} },
    ];
    expect(countReviewableLeaders(nodes)).toBe(1);
  });
});

describe("<SessionChangesPanel />", () => {
  it("requests a diff for the session on mount", () => {
    const send = vi.fn();
    renderPanel({}, { send });
    expect(send).toHaveBeenCalledWith({ type: "get_worktree_diff", sessionKey: "s1" });
  });

  it("merges via approve_changes after confirming", () => {
    const send = vi.fn();
    const onUpdate = vi.fn();
    renderPanel({ approvalPending: true }, { send, onUpdate });
    fireEvent.click(screen.getByText("Merge"));
    const mergeButtons = screen.getAllByText("Merge");
    fireEvent.click(mergeButtons[mergeButtons.length - 1]!);
    expect(send).toHaveBeenCalledWith({ type: "approve_changes", sessionKey: "s1" });
    expect(onUpdate).toHaveBeenCalledWith(
      "l1",
      expect.objectContaining({ worktreeStatus: "merging", approvalPending: false }),
    );
  });

  it("discards via discard_worktree after confirming", () => {
    const send = vi.fn();
    renderPanel({}, { send });
    fireEvent.click(screen.getByText("Discard"));
    const discardButtons = screen.getAllByText("Discard");
    fireEvent.click(discardButtons[discardButtons.length - 1]!);
    expect(send).toHaveBeenCalledWith({ type: "discard_worktree", sessionKey: "s1" });
  });

  it("deep-links to canvas to resolve conflicts", () => {
    const onOpen = vi.fn();
    renderPanel(
      { mergeConflict: { conflicts: ["a.ts"], summary: "", targetBranch: "main" } },
      { onOpen },
    );
    fireEvent.click(screen.getByText("Resolve in Canvas"));
    expect(onOpen).toHaveBeenCalledWith("l1");
  });
});
