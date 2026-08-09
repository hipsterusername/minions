import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface QueuedCall {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

const queue: QueuedCall[] = [];
const observed: { args: string[]; cwd: string }[] = [];

vi.mock("node:child_process", () => {
  return {
    execFile: (
      _file: string,
      args: string[],
      options: { cwd: string },
      cb: (e: Error | null, stdout: string, stderr: string) => void,
    ) => {
      observed.push({ args, cwd: options.cwd });
      const next = queue.shift();
      if (!next) {
        queueMicrotask(() => cb(new Error("unmocked"), "", ""));
        return;
      }
      const stdout = next.stdout ?? "";
      const stderr = next.stderr ?? "";
      queueMicrotask(() =>
        cb(next.ok ? null : new Error("git failed"), stdout, stderr),
      );
    },
  };
});

import { mergeWorktree, mergeAndCleanup } from "./worktree-merge.ts";
import type { WorktreeInfo } from "./worktree-types.ts";

beforeEach(() => {
  queue.length = 0;
  observed.length = 0;
});

afterEach(() => {
  queue.length = 0;
  observed.length = 0;
});

const info: WorktreeInfo = {
  path: "/proj/.canvas-worktrees/k",
  branch: "canvas/k",
  leaderSessionKey: "k",
  createdAt: 0,
  projectPath: "/proj",
  lifecycle: "active",
};

function enqueueTargetInspection(target = "main", sha = "base", checkedOut = "feature") {
  queue.push({ ok: true, stdout: `${target}\n` });
  queue.push({ ok: true, stdout: `${sha}\n` });
  queue.push({ ok: true, stdout: `${checkedOut}\n` });
}

function enqueueExplicitTargetInspection(sha = "base", checkedOut = "feature") {
  queue.push({ ok: true, stdout: `${sha}\n` });
  queue.push({ ok: true, stdout: `${checkedOut}\n` });
}

describe("mergeWorktree — happy path", () => {
  it("merges target into canvas, fast-forwards target ref, and returns success", async () => {
    // Order:
    //  1. rev-parse --abbrev-ref HEAD  (project, to find target branch)
    //  2. merge main --no-edit         (worktree, succeeds first try)
    //  3. rev-parse canvas/k           (project, get canvas SHA)
    //  4. update-ref refs/heads/main <sha>
    //  5. rev-parse --abbrev-ref HEAD  (project, see if main's checked out)
    //  6. (if mainBranch === target) reset --hard target
    enqueueTargetInspection("main", "base", "feature");
    queue.push({ ok: true, stdout: "" });
    queue.push({ ok: true, stdout: "deadbeef\n" });
    queue.push({ ok: true, stdout: "" });
    // No reset call since mainBranch !== target.

    const result = await mergeWorktree(info);
    expect(result.success).toBe(true);
    expect(result.targetBranch).toBe("main");
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toContain("Merged canvas/k into main");

    expect(observed[0]!.args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(observed[0]!.cwd).toBe("/proj");
    expect(observed[3]!.args).toEqual(["merge", "main", "--no-edit"]);
    expect(observed[3]!.cwd).toBe(info.path);
    expect(observed[5]!.args).toEqual([
      "update-ref",
      "refs/heads/main",
      "deadbeef",
      "base",
    ]);
  });

  it("uses the explicit targetBranch when provided (skips abbrev-ref)", async () => {
    enqueueExplicitTargetInspection("base", "feature");
    queue.push({ ok: true, stdout: "" }); // merge develop
    queue.push({ ok: true, stdout: "abc\n" }); // rev-parse canvas
    queue.push({ ok: true, stdout: "" }); // update-ref

    const result = await mergeWorktree(info, "develop");
    expect(result.success).toBe(true);
    expect(observed[2]!.args).toEqual(["merge", "develop", "--no-edit"]);
  });

  it("refuses to merge when the target branch is checked out with uncommitted changes", async () => {
    enqueueTargetInspection("main", "base", "main");
    queue.push({ ok: true, stdout: " M unrelated.ts\n" }); // target checkout dirty

    const result = await mergeWorktree(info);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("uncommitted changes");
    expect(observed.some((o) => o.args[0] === "update-ref")).toBe(false);
  });
});

describe("mergeWorktree — conflict path with default rebase", () => {
  it("aborts the failed merge, rebases, and fast-forwards on rebase success", async () => {
    enqueueTargetInspection();
    queue.push({ ok: false, stderr: "CONFLICT" }); // merge fails
    queue.push({ ok: true, stdout: "" }); // merge --abort
    queue.push({ ok: true, stdout: "" }); // rebase main → succeeds
    queue.push({ ok: true, stdout: "abc\n" }); // rev-parse canvas/k
    queue.push({ ok: true, stdout: "" }); // update-ref

    const result = await mergeWorktree(info);
    expect(result.success).toBe(true);
    // Step trace verifies the abort + rebase path was taken.
    expect(observed.map((o) => o.args[0])).toEqual([
      "rev-parse",
      "rev-parse",
      "rev-parse",
      "merge",
      "merge", // --abort
      "rebase",
      "rev-parse",
      "update-ref",
    ]);
  });

  it("reports conflicts when rebase fails after a merge conflict", async () => {
    enqueueTargetInspection();
    queue.push({ ok: false, stderr: "CONFLICT" });
    queue.push({ ok: true, stdout: "" }); // merge --abort
    queue.push({ ok: false, stderr: "rebase conflict" }); // rebase fails
    queue.push({
      ok: true,
      stdout: "src/a.ts\nsrc/b.ts\n",
    }); // diff --diff-filter=U → conflicting files
    queue.push({ ok: true, stdout: "" }); // rebase --abort

    const result = await mergeWorktree(info);
    expect(result.success).toBe(false);
    expect(result.conflicts).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.summary).toContain("Rebase failed");
    expect(result.summary).toContain("main");
  });

  it("returns the bare merge failure when rebase is explicitly disabled", async () => {
    enqueueTargetInspection();
    queue.push({ ok: false, stderr: "CONFLICT" });
    queue.push({ ok: true, stdout: "" }); // merge --abort

    const result = await mergeWorktree(info, undefined, { rebase: false });
    expect(result.success).toBe(false);
    expect(result.summary).toContain("Merge failed");
    expect(result.conflicts).toEqual([]);
    // No rebase / rev-parse / update-ref call should have happened.
    expect(observed.some((o) => o.args[0] === "rebase")).toBe(false);
  });
});

describe("mergeWorktree — strategy resolution", () => {
  it("with strategy='ours', invokes -X ours and falls through to fast-forward when merge succeeds first try", async () => {
    enqueueTargetInspection();
    queue.push({ ok: true, stdout: "" }); // merge with -X ours succeeds
    queue.push({ ok: true, stdout: "abc\n" }); // rev-parse canvas
    queue.push({ ok: true, stdout: "" }); // update-ref

    const result = await mergeWorktree(info, undefined, { strategy: "ours" });
    expect(result.success).toBe(true);
    expect(observed[3]!.args).toEqual([
      "merge",
      "main",
      "--no-edit",
      "-X",
      "ours",
    ]);
  });

  it("with force=true (no explicit strategy), uses -X ours by default", async () => {
    enqueueTargetInspection();
    queue.push({ ok: true, stdout: "" });
    queue.push({ ok: true, stdout: "abc\n" });
    queue.push({ ok: true, stdout: "" });

    await mergeWorktree(info, undefined, { force: true });
    expect(observed[3]!.args).toEqual([
      "merge",
      "main",
      "--no-edit",
      "-X",
      "ours",
    ]);
  });

  it("on conflict with strategy='theirs', force-resolves each unresolved file via checkout --theirs", async () => {
    enqueueTargetInspection();
    queue.push({ ok: false, stderr: "CONFLICT" }); // merge -X theirs fails on tree conflict
    queue.push({
      ok: true,
      stdout: "src/a.ts\nsrc/b.ts\n",
    }); // diff --diff-filter=U
    queue.push({ ok: true, stdout: "" }); // checkout --theirs a.ts
    queue.push({ ok: true, stdout: "" }); // checkout --theirs b.ts
    queue.push({ ok: true, stdout: "" }); // add -A
    queue.push({ ok: true, stdout: "" }); // commit
    queue.push({ ok: true, stdout: "abc\n" }); // rev-parse canvas
    queue.push({ ok: true, stdout: "" }); // update-ref

    const result = await mergeWorktree(info, undefined, {
      strategy: "theirs",
    });
    expect(result.success).toBe(true);

    const checkoutCalls = observed.filter(
      (o) => o.args[0] === "checkout",
    );
    expect(checkoutCalls).toHaveLength(2);
    expect(checkoutCalls[0]!.args).toEqual([
      "checkout",
      "--theirs",
      "--",
      "src/a.ts",
    ]);
    expect(checkoutCalls[1]!.args).toEqual([
      "checkout",
      "--theirs",
      "--",
      "src/b.ts",
    ]);
  });
});

describe("mergeAndCleanup", () => {
  it("on merge success, calls removeWorktree (worktree remove --force + branch -D)", async () => {
    // Pre-merge: add -A then status --porcelain to detect uncommitted.
    queue.push({ ok: true, stdout: "" }); // add -A
    queue.push({ ok: true, stdout: "" }); // status --porcelain → empty (no auto-commit)
    enqueueTargetInspection();
    queue.push({ ok: true, stdout: "" }); // merge
    queue.push({ ok: true, stdout: "abc\n" });
    queue.push({ ok: true, stdout: "" }); // update-ref
    queue.push({ ok: true, stdout: "" }); // worktree remove --force
    queue.push({ ok: true, stdout: "" }); // branch -D

    // Spread to avoid mutating the shared `info` fixture across tests.
    const localInfo = { ...info };
    const result = await mergeAndCleanup(localInfo);
    expect(result.success).toBe(true);
    expect(localInfo.lifecycle).toBe("cleaned");

    expect(observed.some((o) => o.args[0] === "worktree" && o.args[1] === "remove"))
      .toBe(true);
    expect(observed.some((o) => o.args[0] === "branch" && o.args[1] === "-D"))
      .toBe(true);
  });

  it("on merge failure, leaves the worktree intact (no removeWorktree)", async () => {
    queue.push({ ok: true, stdout: "" }); // add -A
    queue.push({ ok: true, stdout: "" }); // status --porcelain
    enqueueTargetInspection();
    queue.push({ ok: false, stderr: "CONFLICT" });
    queue.push({ ok: true, stdout: "" }); // merge --abort
    queue.push({ ok: false, stderr: "rebase conflict" });
    queue.push({ ok: true, stdout: "src/x.ts\n" }); // diff --diff-filter=U
    queue.push({ ok: true, stdout: "" }); // rebase --abort

    const localInfo = { ...info };
    const result = await mergeAndCleanup(localInfo);
    expect(result.success).toBe(false);
    // Lifecycle did NOT change to "cleaned".
    expect(localInfo.lifecycle).toBe("active");
    expect(observed.some((o) => o.args[0] === "worktree" && o.args[1] === "remove"))
      .toBe(false);
  });

  it("auto-commits uncommitted changes before attempting the merge", async () => {
    queue.push({ ok: true, stdout: "" }); // add -A
    queue.push({ ok: true, stdout: " M src/x.ts\n" }); // status: dirty
    queue.push({ ok: true, stdout: "" }); // commit
    enqueueTargetInspection();
    queue.push({ ok: true, stdout: "" }); // merge
    queue.push({ ok: true, stdout: "abc\n" }); // rev-parse
    queue.push({ ok: true, stdout: "" }); // update-ref
    queue.push({ ok: true, stdout: "" }); // worktree remove
    queue.push({ ok: true, stdout: "" }); // branch -D

    await mergeAndCleanup({ ...info });
    const commitCall = observed.find((o) => o.args[0] === "commit");
    expect(commitCall).toBeTruthy();
    expect(commitCall!.args).toEqual([
      "commit",
      "-m",
      "chore: auto-commit uncommitted changes before merge",
    ]);
  });
});
