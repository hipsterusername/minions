/**
 * server/worktree-exec — thin wrapper around `child_process.execFile`.
 *
 * Tests mock the `node:child_process` boundary and run the real `exec` helper.
 *
 * The contract the wrapper offers:
 *   1. Always invokes `git` (never any other binary).
 *   2. Forwards args + cwd unchanged.
 *   3. Resolves with `{ stdout, stderr }` on exit code 0.
 *   4. Rejects with `Error("git <verb>: <stderr or stdout>")` on
 *      any non-zero exit.
 *   5. Falls back to the underlying error message if both stderr and
 *      stdout are empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeCall {
  argv: { file: string; args: string[]; cwd: string };
  resolve: { error: Error | null; stdout: string; stderr: string };
}

const calls: FakeCall[] = [];
let nextResult: FakeCall["resolve"] = { error: null, stdout: "", stderr: "" };

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      options: { cwd: string },
      cb: (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      calls.push({
        argv: { file, args, cwd: options.cwd },
        resolve: nextResult,
      });
      // Defer to next microtask to mirror the real async behaviour.
      queueMicrotask(() =>
        cb(nextResult.error, nextResult.stdout, nextResult.stderr),
      );
    },
  };
});

import { exec, WORKTREE_DIR } from "./worktree-exec.ts";

beforeEach(() => {
  calls.length = 0;
  nextResult = { error: null, stdout: "", stderr: "" };
});

afterEach(() => {
  calls.length = 0;
});

describe("WORKTREE_DIR constant", () => {
  it("is the documented sidecar directory name", () => {
    // Pinned because every worktree-* module joins this onto a project
    // path; changing it would silently strand existing worktrees.
    expect(WORKTREE_DIR).toBe(".canvas-worktrees");
  });
});

describe("exec — happy path", () => {
  it("invokes the `git` binary with forwarded args and cwd", async () => {
    nextResult = { error: null, stdout: "ok\n", stderr: "" };
    const result = await exec(["status", "--short"], "/some/repo");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv.file).toBe("git");
    expect(calls[0]!.argv.args).toEqual(["status", "--short"]);
    expect(calls[0]!.argv.cwd).toBe("/some/repo");

    expect(result).toEqual({ stdout: "ok\n", stderr: "" });
  });

  it("returns empty strings when execFile reports null stdout/stderr", async () => {
    nextResult = {
      error: null,
      stdout: null as unknown as string,
      stderr: null as unknown as string,
    };
    const result = await exec(["rev-parse", "HEAD"], "/repo");
    expect(result).toEqual({ stdout: "", stderr: "" });
  });
});

describe("exec — error path", () => {
  it("rejects with `git <verb>: <stderr>` when stderr is non-empty", async () => {
    nextResult = {
      error: new Error("Command failed"),
      stdout: "",
      stderr: "fatal: not a git repository\n",
    };
    await expect(exec(["status"], "/notarepo")).rejects.toThrow(
      "git status: fatal: not a git repository",
    );
  });

  it("falls back to stdout when stderr is empty", async () => {
    nextResult = {
      error: new Error("exit 1"),
      stdout: "Some output that contains the cause\n",
      stderr: "",
    };
    await expect(exec(["fetch"], "/x")).rejects.toThrow(
      "git fetch: Some output that contains the cause",
    );
  });

  it("falls back to the underlying error.message when both streams are empty", async () => {
    const inner = new Error("ENOENT spawn git");
    nextResult = { error: inner, stdout: "", stderr: "" };
    await expect(exec(["status"], "/x")).rejects.toThrow(
      "git status: ENOENT spawn git",
    );
  });
});
