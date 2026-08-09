import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeGitIntegration, GitIntegrationWorker } from "./git-integration-worker.ts";
import { provisionPlannedWorktree } from "./worktree-create.ts";
import type { GitIntegrationOperation, GitIntegrationStore } from "./git-integration-types.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function canGit() { try { git(process.cwd(), "--version"); return true; } catch { return false; } }
const roots: string[] = [];
function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minions-git-worker-")); roots.push(root);
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Minions Test");
  git(root, "config", "user.email", "minions@example.test");
  // Mirror production: worktree dirs live under an ignored path so they never
  // register as uncommitted changes in the target checkout's status.
  fs.writeFileSync(path.join(root, ".gitignore"), ".canvas-worktrees/\n");
  fs.writeFileSync(path.join(root, "base.txt"), "base\n"); git(root, "add", ".");
  git(root, "commit", "-m", "initial"); return root;
}
async function contribution(repo: string, branch: string, base: string, file: string, value: string) {
  const pathname = path.join(repo, ".canvas-worktrees", branch.replaceAll("/", "-"));
  await provisionPlannedWorktree({ path: pathname, branch, projectPath: repo,
    leaderSessionKey: branch, createdAt: 1 }, base);
  fs.writeFileSync(path.join(pathname, file), value);
  git(pathname, "add", "."); git(pathname, "commit", "-m", `reviewed ${branch}`);
  return pathname;
}
function operation(repo: string, id: string, kind: GitIntegrationOperation["kind"],
  sourceRef: string, targetRef: string, worktreePath?: string): GitIntegrationOperation {
  return { id, kind, repositoryPath: repo, sourceRef, targetRef,
    expectedSourceSha: git(repo, "rev-parse", sourceRef),
    expectedTargetSha: git(repo, "rev-parse", targetRef),
    fenceToken: 1,
    contributionId: kind === "integrate_contribution" ? id : null,
    ...(worktreePath ? { worktreePath } : {}) };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0))
  fs.rmSync(root, { recursive: true, force: true }); });

describe.runIf(canGit())("persisted Git integration worker", () => {
  it("idempotently provisions a fresh persisted lineage ref and integration worktree", async () => {
    const repo = repository(); const baseSha = git(repo, "rev-parse", "main");
    const source = await contribution(repo, "contrib/fresh", "main", "fresh.txt", "fresh\n");
    const targetWorktreePath = path.join(repo, ".canvas-worktrees", "lineage-fresh");
    const result = await executeGitIntegration({ id: "fresh", kind: "integrate_contribution",
      repositoryPath: repo, sourceRef: "contrib/fresh", targetRef: "lineage/fresh",
      worktreePath: source, targetWorktreePath, lineageId: "lineage-fresh",
      expectedSourceSha: git(repo, "rev-parse", "contrib/fresh"), expectedTargetSha: baseSha,
      fenceToken: 1 });
    expect(result.status).toBe("succeeded");
    expect(git(repo, "show", "lineage/fresh:fresh.txt")).toBe("fresh");
    expect(fs.existsSync(targetWorktreePath)).toBe(true);
  });

  it("serializes and integrates multiple contribution worktrees in queue order", async () => {
    const repo = repository(); git(repo, "branch", "lineage");
    const one = await contribution(repo, "contrib/one", "lineage", "one.txt", "one\n");
    const two = await contribution(repo, "contrib/two", "lineage", "two.txt", "two\n");
    const queue = [operation(repo, "one", "integrate_contribution", "contrib/one", "lineage", one),
      operation(repo, "two", "integrate_contribution", "contrib/two", "lineage", two)];
    const finished: string[] = []; const cleaned: string[] = [];
    const store: GitIntegrationStore = {
      claimNext: async () => queue.shift() ?? null,
      finish: async (id) => { finished.push(id); },
      requeue: async () => undefined,
      markCleaned: async (id) => { cleaned.push(id); },
    };
    const worker = new GitIntegrationWorker(store, { workerId: "worker" });
    const [first, second] = await Promise.all([
      worker.runNext(repo, "lineage"), worker.runNext(repo, "lineage"),
    ]);
    expect(first?.status).toBe("succeeded"); expect(second?.status).toBe("succeeded");
    expect(finished).toEqual(["one", "two"]); expect(cleaned).toEqual(["one", "two"]);
    expect(git(repo, "show", "lineage:one.txt")).toBe("one");
    expect(git(repo, "show", "lineage:two.txt")).toBe("two");
    expect(git(repo, "log", "--first-parent", "--format=%s", "-2", "lineage").split("\n"))
      .toEqual(["minions: integrate_contribution two", "minions: integrate_contribution one"]);
  });

  it("reruns gates after a moved target and preserves the external commit", async () => {
    const repo = repository(); const lineage = await contribution(
      repo, "lineage/moved", "main", "lineage.txt", "lineage\n");
    let moved = false; const gates: string[] = [];
    const result = await executeGitIntegration(
      operation(repo, "promote-moved", "promote_lineage", "lineage/moved", "main"), {
        evaluateGate: async ({ targetSha }) => { gates.push(targetSha); return { allowed: true }; },
        beforePromote: async () => {
          if (moved) return; moved = true;
          fs.writeFileSync(path.join(repo, "external.txt"), "external\n");
          git(repo, "add", "."); git(repo, "commit", "-m", "external");
        },
      });
    expect(result.status).toBe("succeeded"); expect(gates).toHaveLength(2);
    expect(fs.readFileSync(path.join(repo, "lineage.txt"), "utf8")).toBe("lineage\n");
    expect(fs.readFileSync(path.join(repo, "external.txt"), "utf8")).toBe("external\n");
  });

  it("retries an update-ref CAS failure without losing the moved target", async () => {
    const repo = repository(); git(repo, "branch", "lineage");
    const worktree = await contribution(repo, "contrib/cas", "lineage", "cas.txt", "cas\n");
    let raced = false;
    const result = await executeGitIntegration(
      operation(repo, "cas", "integrate_contribution", "contrib/cas", "lineage", worktree), {
        beforeUpdateRef: async ({ targetSha }) => {
          if (raced) return; raced = true;
          const tree = git(repo, "rev-parse", `${targetSha}^{tree}`);
          const moved = git(repo, "commit-tree", tree, "-p", targetSha, "-m", "concurrent target");
          git(repo, "update-ref", "refs/heads/lineage", moved, targetSha);
        },
      });
    expect(result.status).toBe("succeeded");
    expect(git(repo, "log", "--format=%s", "lineage")).toContain("concurrent target");
    expect(git(repo, "show", "lineage:cas.txt")).toBe("cas");
  });

  it("integrates the frozen reviewed SHA and preserves later source changes", async () => {
    const repo = repository(); git(repo, "branch", "lineage");
    const worktree = await contribution(repo, "contrib/frozen", "lineage",
      "reviewed.txt", "reviewed\n");
    const op = operation(repo, "frozen", "integrate_contribution",
      "contrib/frozen", "lineage", worktree);
    const result = await executeGitIntegration(op, { beforePromote: async () => {
      fs.writeFileSync(path.join(worktree, "late.txt"), "not reviewed\n");
      git(worktree, "add", "."); git(worktree, "commit", "-m", "late unreviewed head");
    } });
    expect(result.status).toBe("succeeded");
    expect(git(repo, "show", "lineage:reviewed.txt")).toBe("reviewed");
    expect(() => git(repo, "show", "lineage:late.txt")).toThrow();
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it("rejects a contribution worktree changed after its head was reviewed", async () => {
    const repo = repository(); git(repo, "branch", "lineage");
    const worktree = await contribution(repo, "contrib/dirty-review", "lineage",
      "reviewed.txt", "reviewed\n");
    const op = operation(repo, "dirty-review", "integrate_contribution",
      "contrib/dirty-review", "lineage", worktree);
    fs.writeFileSync(path.join(worktree, "unreviewed.txt"), "unreviewed\n");
    const result = await executeGitIntegration(op);
    expect(result).toMatchObject({ status: "failed",
      error: expect.stringContaining("changed after review") });
    expect(() => git(repo, "show", "lineage:reviewed.txt")).toThrow();
  });

  it("aborts conflicts and preserves the contribution worktree and branch", async () => {
    const repo = repository(); const worktree = await contribution(
      repo, "lineage/conflict", "main", "base.txt", "source\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "target\n"); git(repo, "add", ".");
    git(repo, "commit", "-m", "target");
    const op = operation(repo, "conflict", "promote_lineage", "lineage/conflict", "main", worktree);
    let persisted: Parameters<GitIntegrationStore["finish"]>[2] | undefined;
    const store: GitIntegrationStore = { claimNext: async () => op,
      finish: async (_id, _status, detail) => { persisted = detail; }, requeue: async () => undefined };
    const result = await new GitIntegrationWorker(store, { workerId: "worker",
      evaluateGate: async () => ({ allowed: true }) }).runNext(repo, "main");
    expect(result?.status).toBe("conflicted");
    if (result?.status === "conflicted") {
      expect(result.conflicts).toEqual(["base.txt"]); expect(result.preservedPaths).toEqual([worktree]);
      expect(persisted?.conflictDetails).toEqual({ conflicts: ["base.txt"], preservedPaths: [worktree],
        targetSha: result.targetSha, sourceSha: result.sourceSha });
    }
    expect(fs.existsSync(worktree)).toBe(true);
    expect(git(repo, "show-ref", "--verify", "refs/heads/lineage/conflict")).not.toBe("");
  });

  it("waits on a dirty main checkout without resetting user changes", async () => {
    const repo = repository(); const lineage = await contribution(
      repo, "lineage/dirty", "main", "lineage.txt", "lineage\n");
    const before = git(repo, "rev-parse", "main");
    fs.writeFileSync(path.join(repo, "base.txt"), "user dirty\n");
    const result = await executeGitIntegration(
      operation(repo, "dirty", "promote_lineage", "lineage/dirty", "main"),
      { evaluateGate: async () => ({ allowed: true }) });
    expect(result).toMatchObject({ status: "waiting", error: expect.stringContaining("dirty") });
    expect(git(repo, "rev-parse", "main")).toBe(before);
    expect(fs.readFileSync(path.join(repo, "base.txt"), "utf8")).toBe("user dirty\n");
  });

  it("blocks promotion on failing gates without touching the target", async () => {
    const repo = repository(); const lineage = await contribution(
      repo, "lineage/gated", "main", "gated.txt", "gated\n");
    const before = git(repo, "rev-parse", "main");
    const recorded = vi.fn(); const result = await executeGitIntegration(
      operation(repo, "gated", "promote_lineage", "lineage/gated", "main"), {
        evaluateGate: async () => ({ allowed: false, reason: "tests failed" }),
        onGateEvaluated: recorded,
      });
    expect(result).toMatchObject({ status: "failed", error: "tests failed" });
    expect(git(repo, "rev-parse", "main")).toBe(before);
    expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: expect.any(String) }),
      { allowed: false, reason: "tests failed" });
  });

  it("recovers idempotently after promotion crashes before durable completion", async () => {
    const repo = repository(); git(repo, "branch", "lineage");
    const worktree = await contribution(repo, "contrib/crash", "lineage", "crash.txt", "crash\n");
    const op = operation(repo, "crash", "integrate_contribution", "contrib/crash", "lineage", worktree);
    await expect(executeGitIntegration(op, { afterPromote: async () => {
      throw new Error("simulated worker crash");
    } })).rejects.toThrow("simulated worker crash");
    expect(fs.existsSync(worktree)).toBe(true);
    const recovered = await executeGitIntegration(op);
    expect(recovered).toMatchObject({ status: "succeeded", recovered: true,
      headReachable: true, cleaned: false });
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it("persists success before cleanup and recovers when durable finish fails", async () => {
    const repo = repository(); git(repo, "branch", "lineage");
    const worktree = await contribution(repo, "contrib/finish-crash", "lineage",
      "finish.txt", "finish\n");
    const op = operation(repo, "finish-crash", "integrate_contribution",
      "contrib/finish-crash", "lineage", worktree);
    let failFinish = true; const store: GitIntegrationStore = {
      claimNext: async () => op,
      finish: async () => { if (failFinish) throw new Error("database unavailable"); },
      requeue: async () => undefined, markCleaned: async () => undefined,
    };
    const worker = new GitIntegrationWorker(store, { workerId: "crash-worker" });
    await expect(worker.runNext(repo, "lineage")).rejects.toThrow("database unavailable");
    expect(fs.existsSync(worktree)).toBe(true);
    failFinish = false;
    const recovered = await worker.runNext(repo, "lineage");
    expect(recovered).toMatchObject({ status: "succeeded", recovered: true, cleaned: true });
    expect(fs.existsSync(worktree)).toBe(false);
  });
});
