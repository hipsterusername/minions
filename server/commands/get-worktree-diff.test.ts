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
vi.mock("../workspace-diff.ts", () => ({ getWorkspaceDiff: vi.fn(async () => fakeDiff) }));
import { getWorkspaceDiff } from "../workspace-diff.ts";

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
    h.host.worktreeIsolation = true;
    getWorktreeDiff(h.ctx, cmd({ type: "get_worktree_diff" }), h.ws);
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No worktree");
  });

  it("reads a live leader's working directory and preserves response correlation", async () => {
    const h = setup({ cwd: "/live-project" });
    getWorktreeDiff(h.ctx, cmd({ type: "get_worktree_diff", requestId: "live-review" }), h.ws);
    await Promise.resolve();
    expect(getWorkspaceDiff).toHaveBeenCalledWith("/live-project");
    expect(h.wsSent[0]).toMatchObject({ success: true, diff: fakeDiff, requestId: "live-review" });
  });

  it("reports live workspace failures instead of an empty successful diff", async () => {
    vi.mocked(getWorkspaceDiff).mockRejectedValueOnce(new Error("Not a Git repository"));
    const h = setup();
    getWorktreeDiff(h.ctx, cmd({ type: "get_worktree_diff" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.wsSent[0]).toMatchObject({ success: false, error: "Not a Git repository" });
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
