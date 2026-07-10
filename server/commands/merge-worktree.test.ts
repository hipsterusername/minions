/**
 * merge_worktree — non-approval merge path. Like the merge-flow handlers
 * it calls `mergeAndCleanup`, but does NOT change session status, abort
 * the agent, or emit approval_resolved. The session stays alive so the
 * user can continue working in a fresh worktree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeResult, WorktreeInfo } from "../worktree-types.ts";
import { setup, cmd } from "../../tests/support/server-command-harness.ts";

const calls: { options?: unknown }[] = [];
let result: MergeResult = {
  success: true,
  conflicts: [],
  summary: "merged",
  targetBranch: "main",
};

vi.mock("../worktree.ts", () => ({
  mergeAndCleanup: vi.fn(async (_info, _target, options) => {
    calls.push({ options });
    return result;
  }),
}));

import { mergeWorktree } from "./merge-worktree.ts";

const fakeWorktree: WorktreeInfo = {
  path: "/p/.canvas-worktrees/k",
  branch: "canvas/k",
  leaderSessionKey: "leader-1",
  createdAt: 0,
  projectPath: "/p",
  lifecycle: "active",
};

beforeEach(() => {
  calls.length = 0;
  result = {
    success: true,
    conflicts: [],
    summary: "merged",
    targetBranch: "main",
  };
});

afterEach(() => {
  calls.length = 0;
});

describe("merge_worktree", () => {
  it("on success: clears worktree but does NOT flip session status to completed", async () => {
    const h = setup({ status: "running" });
    h.host.worktree = fakeWorktree;

    mergeWorktree(h.ctx, cmd({ type: "merge_worktree" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.host.worktree).toBeNull();
    expect(h.host.cwd).toBe("/p");
    // Critical difference vs approve_changes — status NOT flipped.
    expect(h.host.status).toBe("running");

    // Only worktree_merged emitted; no session_completed / approval_resolved.
    expect(h.busSent.find((e) => e.type === "worktree_merged")).toBeDefined();
    expect(h.busSent.some((e) => e.type === "session_completed")).toBe(false);
    expect(h.busSent.some((e) => e.type === "approval_resolved")).toBe(false);
  });

  it("on failure: emits worktree_merge_failed and replies with success=true at dispatcher level", async () => {
    result = {
      success: false,
      conflicts: ["x"],
      summary: "conflict",
      targetBranch: "main",
    };
    const h = setup({ status: "running" });
    h.host.worktree = fakeWorktree;

    mergeWorktree(h.ctx, cmd({ type: "merge_worktree" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.host.worktree).toBe(fakeWorktree);
    expect(
      h.busSent.find((e) => e.type === "worktree_merge_failed"),
    ).toBeDefined();
    const ack = h.wsSent.find((e) => e["type"] === "control_response");
    expect((ack!["result"] as MergeResult).success).toBe(false);
  });

  it("rejects with control_error when no worktree is attached", () => {
    const h = setup();
    mergeWorktree(h.ctx, cmd({ type: "merge_worktree" }), h.ws);
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No worktree");
    expect(calls).toHaveLength(0);
  });
});
