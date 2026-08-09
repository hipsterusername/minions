import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktree, mergeAndCleanup } from "./worktree.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function canSpawnGit(): boolean {
  try {
    git(process.cwd(), "--version");
    return true;
  } catch {
    return false;
  }
}

describe.runIf(canSpawnGit())("worktree lifecycle against a real temporary Git repository", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("creates, auto-commits, fast-forwards, refreshes main, and cleans up", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "minions-worktree-integration-"));
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "minions-test@example.invalid");
    git(root, "config", "user.name", "Minions Test");
    // Mirror production: worktree dirs live under an ignored path so they never
    // register as uncommitted changes in the main checkout's status.
    fs.writeFileSync(path.join(root, ".gitignore"), ".canvas-worktrees/\n");
    fs.writeFileSync(path.join(root, "README.md"), "before\n");
    git(root, "add", ".gitignore", "README.md");
    git(root, "commit", "-m", "initial");

    const info = await createWorktree(root, "leader-integration");
    fs.writeFileSync(path.join(info.path, "README.md"), "after\n");
    fs.writeFileSync(path.join(info.path, "result.txt"), "created by leader\n");

    const result = await mergeAndCleanup(info);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("after\n");
    expect(fs.readFileSync(path.join(root, "result.txt"), "utf8")).toBe(
      "created by leader\n",
    );
    expect(fs.existsSync(info.path)).toBe(false);
    expect(git(root, "branch", "--list", "canvas/leader-integration")).toBe("");
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
