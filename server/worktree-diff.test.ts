/**
 * server/worktree-diff — git status + detailed-diff parsing.
 *
 * The `node:child_process` mock is keyed by Git verb so tests can declare
 * expectations per call regardless of order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface QueuedResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

const queue: QueuedResult[] = [];
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
      const stdout = next.stdout;
      const stderr = next.stderr ?? "";
      queueMicrotask(() =>
        cb(next.ok ? null : new Error("git failed"), stdout, stderr),
      );
    },
  };
});

import { getDetailedDiff, getWorktreeStatus } from "./worktree-diff.ts";
import type { WorktreeInfo } from "./worktree-types.ts";

beforeEach(() => {
  queue.length = 0;
  observed.length = 0;
});

afterEach(() => {
  queue.length = 0;
  observed.length = 0;
});

const fakeInfo: WorktreeInfo = {
  path: "/proj/.canvas-worktrees/k",
  branch: "canvas/k",
  leaderSessionKey: "k",
  createdAt: 0,
  projectPath: "/proj",
  lifecycle: "active",
};

describe("getWorktreeStatus", () => {
  it("parses files-changed / insertions / deletions from --stat output", async () => {
    queue.push({
      ok: true,
      stdout: [
        " a.ts | 5 +++--",
        " b.ts | 3 ---",
        " 2 files changed, 5 insertions(+), 3 deletions(-)",
      ].join("\n"),
    });

    const out = await getWorktreeStatus("/proj/.canvas-worktrees/k");

    expect(out.filesChanged).toBe(2);
    expect(out.insertions).toBe(5);
    expect(out.deletions).toBe(3);
    expect(out.summary).toContain("2 files changed");
    expect(observed[0]!.args).toEqual(["diff", "--stat"]);
    expect(observed[0]!.cwd).toBe("/proj/.canvas-worktrees/k");
  });

  it("treats a 1-file-changed line correctly (singular `file`)", async () => {
    queue.push({
      ok: true,
      stdout: [
        " a.ts | 1 +",
        " 1 file changed, 1 insertion(+)",
      ].join("\n"),
    });
    const out = await getWorktreeStatus("/x");
    expect(out.filesChanged).toBe(1);
    expect(out.insertions).toBe(1);
    expect(out.deletions).toBe(0);
  });

  it("returns zeros + 'No changes' for an empty stdout", async () => {
    queue.push({ ok: true, stdout: "" });
    expect(await getWorktreeStatus("/x")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      summary: "No changes",
    });
  });

  it("returns zeros + 'No changes' when git fails entirely", async () => {
    queue.push({ ok: false, stdout: "", stderr: "fatal" });
    expect(await getWorktreeStatus("/x")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      summary: "No changes",
    });
  });
});

describe("getDetailedDiff", () => {
  it("aggregates committed numstat, uncommitted numstat, name-status, and commits", async () => {
    // Order of git calls inside getDetailedDiff:
    //   1. merge-base HEAD canvas/k          (in projectPath)
    //   2. diff --numstat <merge-base> canvas/k  (in projectPath)
    //   3. diff --numstat HEAD               (in worktree path)
    //   4. diff --name-status <merge-base> canvas/k  (in projectPath)
    //   5. log --oneline <merge-base>..canvas/k (in projectPath)
    queue.push({ ok: true, stdout: "abc123\n" }); // merge-base
    queue.push({
      ok: true,
      stdout: ["3\t1\tsrc/a.ts", "0\t10\tsrc/b.ts"].join("\n"),
    }); // committed numstat
    queue.push({
      ok: true,
      stdout: ["2\t0\tsrc/a.ts"].join("\n"),
    }); // uncommitted numstat (adds to a.ts)
    queue.push({
      ok: true,
      stdout: ["A\tsrc/a.ts", "D\tsrc/b.ts"].join("\n"),
    }); // name-status
    queue.push({
      ok: true,
      stdout: ["abc1234 first commit", "def5678 second"].join("\n"),
    }); // log

    const out = await getDetailedDiff(fakeInfo);

    // Two unique files. a.ts: committed (3 ins, 1 del) + uncommitted (2 ins, 0 del).
    // b.ts: committed (0 ins, 10 del). Totals: 5 ins, 11 del.
    expect(out.filesChanged).toBe(2);
    expect(out.insertions).toBe(5);
    expect(out.deletions).toBe(11);

    const aFile = out.files.find((f) => f.file === "src/a.ts")!;
    expect(aFile.insertions).toBe(5);
    expect(aFile.deletions).toBe(1);
    expect(aFile.status).toBe("added");

    const bFile = out.files.find((f) => f.file === "src/b.ts")!;
    expect(bFile.insertions).toBe(0);
    expect(bFile.deletions).toBe(10);
    expect(bFile.status).toBe("deleted");

    expect(out.commits).toEqual(["abc1234 first commit", "def5678 second"]);
    expect(out.branch).toBe("canvas/k");
  });

  it("falls back to HEAD when merge-base fails", async () => {
    queue.push({ ok: false, stdout: "", stderr: "no merge base" });
    queue.push({ ok: true, stdout: "" });
    queue.push({ ok: true, stdout: "" });
    queue.push({ ok: true, stdout: "" });
    queue.push({ ok: true, stdout: "" });

    const out = await getDetailedDiff(fakeInfo);
    expect(out.filesChanged).toBe(0);
    // The merge-base fallback used "HEAD" — the second call's args should
    // reference HEAD as the base.
    expect(observed[1]!.args).toEqual([
      "diff",
      "--numstat",
      "HEAD",
      "canvas/k",
    ]);
  });

  it("treats `-` numstat values as binary diffs (zero insertions/deletions)", async () => {
    queue.push({ ok: true, stdout: "abc\n" }); // merge-base
    queue.push({
      ok: true,
      stdout: "-\t-\timg.png",
    }); // committed numstat — binary
    queue.push({ ok: true, stdout: "" }); // uncommitted
    queue.push({ ok: true, stdout: "M\timg.png" }); // name-status
    queue.push({ ok: true, stdout: "" }); // log

    const out = await getDetailedDiff(fakeInfo);
    expect(out.filesChanged).toBe(1);
    expect(out.insertions).toBe(0);
    expect(out.deletions).toBe(0);
    expect(out.files[0]!.file).toBe("img.png");
  });
});
