import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface QueuedCall {
  expected: (string | null)[] | null;
  /** What the mock should respond with. */
  result:
    | { ok: true; stdout?: string; stderr?: string }
    | { ok: false; stdout?: string; stderr?: string };
}

const queue: QueuedCall[] = [];
const observed: { args: string[]; cwd: string }[] = [];

vi.mock("node:child_process", () => {
  return {
    execFile: (
      _file: string,
      args: string[],
      options: { cwd: string },
      cb: (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      observed.push({ args, cwd: options.cwd });
      const next = queue.shift();
      if (!next) {
        queueMicrotask(() => cb(new Error("unmocked git call"), "", ""));
        return;
      }
      const stdout = next.result.stdout ?? "";
      const stderr = next.result.stderr ?? "";
      if (next.result.ok) {
        queueMicrotask(() => cb(null, stdout, stderr));
      } else {
        queueMicrotask(() => cb(new Error("git failed"), stdout, stderr));
      }
    },
  };
});

import {
  cleanupStaleWorktrees,
  createWorktree,
  isGitRepo,
  listWorktrees,
  removeWorktree,
} from "./worktree-create.ts";
import { registerWorkspace } from "./workspace-registry.ts";

let projectDir: string;
let minionsHome: string;

beforeEach(() => {
  queue.length = 0;
  observed.length = 0;
  projectDir = mkdtempSync(join(tmpdir(), "wt-create-test-"));
  minionsHome = mkdtempSync(join(tmpdir(), "wt-state-test-"));
  vi.stubEnv("MINIONS_HOME", minionsHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(minionsHome, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("invokes `git worktree add <path> -b canvas/<key>` with the project cwd", async () => {
    queue.push({ expected: null, result: { ok: true } });

    const info = await createWorktree(projectDir, "leader-abc");

    expect(observed).toHaveLength(1);
    expect(observed[0]!.args).toEqual([
      "worktree",
      "add",
      join(projectDir, ".canvas-worktrees", "leader-abc"),
      "-b",
      "canvas/leader-abc",
    ]);
    expect(observed[0]!.cwd).toBe(projectDir);

    // The worktree base directory was created on disk before invoking git.
    expect(existsSync(join(projectDir, ".canvas-worktrees"))).toBe(true);

    // Returned WorktreeInfo carries the documented shape.
    expect(info.path).toBe(
      join(projectDir, ".canvas-worktrees", "leader-abc"),
    );
    expect(info.branch).toBe("canvas/leader-abc");
    expect(info.leaderSessionKey).toBe("leader-abc");
    expect(info.projectPath).toBe(projectDir);
    expect(info.lifecycle).toBe("active");
    expect(typeof info.createdAt).toBe("number");
  });

  it("propagates the typed error from a failed `git worktree add`", async () => {
    queue.push({
      expected: null,
      result: {
        ok: false,
        stderr: "fatal: invalid reference: HEAD",
      },
    });
    await expect(createWorktree(projectDir, "k")).rejects.toThrow(
      /git worktree:.*invalid reference/,
    );
  });

  it("creates registered workspace worktrees beneath central Minions state", async () => {
    const workspace = registerWorkspace(projectDir)!;
    queue.push({ expected: null, result: { ok: true } });

    const info = await createWorktree(projectDir, "central-run");

    expect(info.path).toBe(join(workspace.stateRoot, "worktrees", "central-run"));
    expect(observed[0]!.args.slice(0, 3)).toEqual(["worktree", "add", info.path]);
    expect(existsSync(join(projectDir, ".canvas-worktrees"))).toBe(false);
  });

  it("rejects a symlinked central root before invoking git", async () => {
    const workspace = registerWorkspace(projectDir)!;
    const outside = mkdtempSync(join(tmpdir(), "wt-outside-"));
    symlinkSync(outside, join(workspace.stateRoot, "worktrees"), "junction");
    try {
      await expect(createWorktree(projectDir, "escaped")).rejects.toThrow(/real Minions-owned root/);
      expect(observed).toHaveLength(0);
      expect(existsSync(join(outside, "escaped"))).toBe(false);
    } finally {
      rmSync(join(workspace.stateRoot, "worktrees"), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a session key that would traverse outside the root", async () => {
    await expect(createWorktree(projectDir, "../escaped")).rejects.toThrow(/outside a real/);
    expect(observed).toHaveLength(0);
  });
});

describe("removeWorktree", () => {
  it("deletes the exact persisted branch instead of deriving it from the path", async () => {
    const wtPath = join(projectDir, ".canvas-worktrees", "opaque-id");
    mkdirSync(wtPath, { recursive: true });
    queue.push({ expected: null, result: { ok: true } });
    queue.push({ expected: null, result: { ok: true } });
    await removeWorktree(wtPath, projectDir, "refs/heads/contributions/reviewed");
    expect(observed[1]!.args).toEqual(["branch", "-D", "contributions/reviewed"]);
  });

  it("issues both `git worktree remove --force` and `git branch -D`", async () => {
    const wtPath = join(projectDir, ".canvas-worktrees", "leader-1");
    mkdirSync(wtPath, { recursive: true });
    queue.push({ expected: null, result: { ok: true } });
    queue.push({ expected: null, result: { ok: true } });

    await removeWorktree(wtPath, projectDir);

    expect(observed).toHaveLength(2);
    expect(observed[0]!.args).toEqual([
      "worktree",
      "remove",
      "--force",
      wtPath,
    ]);
    expect(observed[0]!.cwd).toBe(projectDir);
    expect(observed[1]!.args).toEqual(["branch", "-D", "canvas/leader-1"]);
    expect(observed[1]!.cwd).toBe(projectDir);
  });

  it("derives the project path from `<wt>/../..` when not supplied", async () => {
    const wtPath = join(projectDir, ".canvas-worktrees", "k");
    mkdirSync(wtPath, { recursive: true });
    queue.push({ expected: null, result: { ok: true } });
    queue.push({ expected: null, result: { ok: true } });

    await removeWorktree(wtPath);

    // Both calls run in `<wt>/../..` which is `projectDir`.
    expect(observed[0]!.cwd).toBe(join(wtPath, "..", ".."));
    expect(observed[1]!.cwd).toBe(join(wtPath, "..", ".."));
  });

  it("rejects explicit removal outside central and legacy owned roots", async () => {
    const outside = join(projectDir, "ordinary-folder");
    mkdirSync(outside);
    await expect(removeWorktree(outside, projectDir)).rejects.toThrow(/outside Minions-owned roots/);
    expect(observed).toHaveLength(0);
  });

  it("rejects removal through a symlinked owned path", async () => {
    const base = join(projectDir, ".canvas-worktrees");
    const outside = mkdtempSync(join(tmpdir(), "wt-remove-outside-"));
    mkdirSync(base);
    symlinkSync(outside, join(base, "linked"), "junction");
    try {
      await expect(removeWorktree(join(base, "linked"), projectDir)).rejects.toThrow(
        /outside Minions-owned roots/,
      );
      expect(observed).toHaveLength(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("listWorktrees", () => {
  it("parses porcelain output and filters to the canvas worktree base", async () => {
    const base = join(projectDir, ".canvas-worktrees");
    const a = join(base, "alpha");
    const b = join(base, "beta");
    const otherWorktree = join(projectDir, "..", "outside-worktree");

    queue.push({
      expected: null,
      result: {
        ok: true,
        stdout: [
          `worktree ${projectDir}`,
          "HEAD abc",
          "branch refs/heads/main",
          "",
          `worktree ${a}`,
          "HEAD def",
          "branch refs/heads/canvas/alpha",
          "",
          `worktree ${b}`,
          "HEAD 123",
          "branch refs/heads/canvas/beta",
          "",
          `worktree ${otherWorktree}`,
          "HEAD 456",
          "branch refs/heads/some-other",
          "",
        ].join("\n"),
      },
    });

    const result = await listWorktrees(projectDir);

    // Only the two canvas worktrees survive the filter.
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe(a);
    expect(result[0]!.branch).toBe("canvas/alpha");
    expect(result[0]!.leaderSessionKey).toBe("alpha");
    expect(result[1]!.path).toBe(b);
    expect(result[1]!.leaderSessionKey).toBe("beta");
  });
});

describe("isGitRepo", () => {
  it("returns true when `git rev-parse --git-dir` succeeds", async () => {
    queue.push({
      expected: null,
      result: { ok: true, stdout: ".git\n" },
    });
    expect(await isGitRepo(projectDir)).toBe(true);
  });

  it("returns false when the call fails", async () => {
    queue.push({
      expected: null,
      result: { ok: false, stderr: "fatal: not a git repository" },
    });
    expect(await isGitRepo(projectDir)).toBe(false);
  });
});

describe("cleanupStaleWorktrees", () => {
  it("runs `git worktree prune` then attempts to rmdir empty entries", async () => {
    const base = join(projectDir, ".canvas-worktrees");
    mkdirSync(join(base, "empty"), { recursive: true });

    queue.push({ expected: null, result: { ok: true } });

    await cleanupStaleWorktrees(projectDir);

    expect(observed[0]!.args).toEqual(["worktree", "prune"]);
    expect(existsSync(join(base, "empty"))).toBe(false);
  });

  it("is a no-op when the worktree base directory does not exist", async () => {
    queue.push({ expected: null, result: { ok: true } });
    await expect(cleanupStaleWorktrees(projectDir)).resolves.toBeUndefined();
    expect(observed[0]!.args).toEqual(["worktree", "prune"]);
  });
});
