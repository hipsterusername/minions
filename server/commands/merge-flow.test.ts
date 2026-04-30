/**
 * Shared coverage for the 4 commands that go through `runMergeFlow`:
 *   approve_changes, force_merge, theirs_merge, retry_merge.
 *
 * Per docs/testing-strategy.md §5.9 we collapse the four near-identical
 * test files into one parameterised describe — the only behavioural
 * difference between them is the `MergeOptions` they pass into
 * `mergeAndCleanup`. All four:
 *   - reject when the session has no worktree (control_error)
 *   - on merge success: emit session_status(completed) +
 *     worktree_merged + approval_resolved + session_completed,
 *     clear worktree, set host.status=completed
 *   - on merge failure: emit worktree_merge_failed and preserve worktree
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeResult } from "../worktree-types.ts";
import { setup, cmd } from "./test-harness.ts";
import { disablePersistence } from "../session-persist.ts";

interface MergeCall {
  // (info, targetBranch?, options?) per `mergeAndCleanup` signature.
  options?: { force?: boolean; strategy?: "ours" | "theirs"; rebase?: boolean };
}

const mergeCalls: MergeCall[] = [];
let mergeResult: MergeResult | (() => Promise<MergeResult>) = {
  success: true,
  conflicts: [],
  summary: "merged",
  targetBranch: "main",
};

vi.mock("../worktree.ts", () => {
  return {
    mergeAndCleanup: vi.fn(async (_info, _target, options) => {
      mergeCalls.push({ options });
      return typeof mergeResult === "function" ? mergeResult() : mergeResult;
    }),
  };
});

import { approveChanges } from "./approve-changes.ts";
import { forceMerge } from "./force-merge.ts";
import { theirsMerge } from "./theirs-merge.ts";
import { retryMerge } from "./retry-merge.ts";
import type { WorktreeInfo } from "../worktree-types.ts";

beforeEach(() => {
  disablePersistence();
  mergeCalls.length = 0;
  mergeResult = {
    success: true,
    conflicts: [],
    summary: "merged",
    targetBranch: "main",
  };
});

afterEach(() => {
  mergeCalls.length = 0;
});

const fakeWorktree: WorktreeInfo = {
  path: "/proj/.canvas-worktrees/k",
  branch: "canvas/k",
  leaderSessionKey: "leader-1",
  createdAt: 0,
  projectPath: "/proj",
  lifecycle: "active",
};

const CASES = [
  {
    command: "approve_changes",
    handler: approveChanges,
    expectedOptions: undefined,
  },
  {
    command: "force_merge",
    handler: forceMerge,
    expectedOptions: { force: true },
  },
  {
    command: "theirs_merge",
    handler: theirsMerge,
    expectedOptions: { strategy: "theirs" as const },
  },
  {
    command: "retry_merge",
    handler: retryMerge,
    expectedOptions: undefined,
  },
];

describe.each(CASES)(
  "$command",
  ({ command, handler, expectedOptions }) => {
    it("rejects with control_error when the session has no worktree", () => {
      const h = setup({ status: "running" });
      // host.worktree stays null.
      handler(h.ctx, cmd({ type: command as never }), h.ws);
      expect(h.wsSent).toHaveLength(1);
      expect(h.wsSent[0]!["success"]).toBe(false);
      expect(h.wsSent[0]!["error"]).toContain("No worktree");
      expect(mergeCalls).toHaveLength(0);
    });

    it("on merge success: clears worktree, emits the four success envelopes, replies with success", async () => {
      const h = setup({ status: "running" });
      h.host.worktree = fakeWorktree;

      handler(h.ctx, cmd({ type: command as never }), h.ws);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Right merge options forwarded to mergeAndCleanup.
      expect(mergeCalls).toHaveLength(1);
      expect(mergeCalls[0]!.options).toEqual(expectedOptions);

      // Host transitioned to completed; worktree dropped.
      expect(h.host.status).toBe("completed");
      expect(h.host.worktree).toBeNull();
      expect(h.host.cwd).toBe("/proj");

      // Bus saw all four success envelopes.
      const types = h.busSent.map((e) => e.type);
      expect(types).toContain("session_status");
      expect(types).toContain("worktree_merged");
      expect(types).toContain("approval_resolved");
      expect(types).toContain("session_completed");

      // The success control_response went out.
      const ack = h.wsSent.find((e) => e["type"] === "control_response");
      expect(ack).toBeDefined();
      expect(ack!["success"]).toBe(true);
    });

    it("on merge failure: emits worktree_merge_failed and leaves the worktree on the host", async () => {
      mergeResult = {
        success: false,
        conflicts: ["src/x.ts"],
        summary: "conflict",
        targetBranch: "main",
      };
      const h = setup({ status: "running" });
      h.host.worktree = fakeWorktree;

      handler(h.ctx, cmd({ type: command as never }), h.ws);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Worktree intact, status not flipped to completed.
      expect(h.host.worktree).toBe(fakeWorktree);
      expect(h.host.status).toBe("running");

      // Failed envelope emitted, NOT session_completed.
      const failed = h.busSent.find((e) => e.type === "worktree_merge_failed");
      expect(failed).toBeDefined();
      expect(h.busSent.some((e) => e.type === "session_completed")).toBe(false);

      // control_response carries the failed result.
      const ack = h.wsSent.find((e) => e["type"] === "control_response");
      expect(ack).toBeDefined();
      expect(ack!["success"]).toBe(true); // success at the dispatcher level
      const result = ack!["result"] as MergeResult;
      expect(result.success).toBe(false);
      expect(result.conflicts).toEqual(["src/x.ts"]);
    });

    it("aborts a running session before initiating the merge", async () => {
      const h = setup({ status: "running" });
      h.host.worktree = fakeWorktree;
      expect(h.host.abortController.signal.aborted).toBe(false);

      handler(h.ctx, cmd({ type: command as never }), h.ws);
      // The abort happens synchronously before the await resolves.
      expect(h.host.abortController.signal.aborted).toBe(true);
    });
  },
);
