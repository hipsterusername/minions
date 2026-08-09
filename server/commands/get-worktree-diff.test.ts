/**
 * get_worktree_diff — fetches a DetailedDiff and forwards it as a
 * control_response. Mocks `getDetailedDiff` at the boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetailedDiff, WorktreeInfo } from "../worktree-types.ts";
import { setup, cmd } from "../../tests/support/server-command-harness.ts";

let throwFromDiff = false;
const fakeDiff: DetailedDiff = {
  filesChanged: 1,
  insertions: 5,
  deletions: 2,
  files: [{ file: "a.ts", insertions: 5, deletions: 2, status: "modified" }],
  commits: ["abc first commit"],
  branch: "canvas/k",
};

vi.mock("../worktree.ts", () => ({
  getDetailedDiff: vi.fn(async () => {
    if (throwFromDiff) throw new Error("git failed");
    return fakeDiff;
  }),
}));

import { getWorktreeDiff } from "./get-worktree-diff.ts";

const fakeWorktree: WorktreeInfo = {
  path: "/p/.canvas-worktrees/k",
  branch: "canvas/k",
  leaderSessionKey: "leader-1",
  createdAt: 0,
  projectPath: "/p",
  lifecycle: "active",
};

beforeEach(() => {
  throwFromDiff = false;
});

afterEach(() => {
  throwFromDiff = false;
});

describe("get_worktree_diff", () => {
  it("returns the DetailedDiff verbatim under control_response.diff", async () => {
    const h = setup();
    h.host.worktree = fakeWorktree;

    getWorktreeDiff(h.ctx, cmd({ type: "get_worktree_diff" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["diff"]).toEqual(fakeDiff);
  });

  it("rejects with control_error when no worktree is attached", () => {
    const h = setup();
    getWorktreeDiff(h.ctx, cmd({ type: "get_worktree_diff" }), h.ws);
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No worktree");
  });

  it("propagates getDetailedDiff failure as control_error", async () => {
    throwFromDiff = true;
    const h = setup();
    h.host.worktree = fakeWorktree;

    getWorktreeDiff(h.ctx, cmd({ type: "get_worktree_diff" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("git failed");
  });
});
