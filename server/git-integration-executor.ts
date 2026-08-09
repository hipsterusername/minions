import fs from "node:fs";
import path from "node:path";
import { exec } from "./worktree-exec.ts";
import { provisionPlannedWorktree } from "./worktree-create.ts";
import { ownedWorktreeRoot } from "./worktree-owned-root.ts";
import type { GitGateContext, GitIntegrationExecutorOptions,
  GitIntegrationOperation, GitIntegrationResult } from "./git-integration-types.ts";

function fullRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref;
  if (!ref || ref.startsWith("-") || ref.includes("..")) throw new Error(`unsafe Git ref: ${ref}`);
  return `refs/heads/${ref}`;
}
async function sha(repo: string, ref: string): Promise<string> {
  return (await exec(["rev-parse", fullRef(ref)], repo)).stdout.trim();
}
async function ancestor(repo: string, older: string, newer: string): Promise<boolean> {
  try { await exec(["merge-base", "--is-ancestor", older, newer], repo); return true; }
  catch { return false; }
}
export async function collectGitContribution(input: { repositoryPath: string;
  worktreePath: string; sourceRef: string; message: string }): Promise<string> {
  const repo = fs.realpathSync(input.repositoryPath);
  await exec(["add", "-A"], input.worktreePath);
  if ((await exec(["status", "--porcelain"], input.worktreePath)).stdout.trim()) {
    await exec(["commit", "-m", input.message], input.worktreePath);
  }
  const head = await sha(repo, input.sourceRef);
  if ((await exec(["status", "--porcelain"], input.worktreePath)).stdout.trim()) {
    throw new Error("contribution worktree remained dirty after collection");
  }
  return head;
}
async function targetCheckout(repo: string, targetRef: string): Promise<string | null> {
  const blocks = (await exec(["worktree", "list", "--porcelain"], repo)).stdout.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7);
    if (worktree && branch === fullRef(targetRef)) return worktree;
  }
  return null;
}
async function dirty(pathname: string): Promise<boolean> {
  return Boolean((await exec(["status", "--porcelain"], pathname)).stdout.trim());
}
function integrationPath(repo: string, id: string): string {
  return path.join(ownedWorktreeRoot(repo), `.integration-${id.replace(/[^a-zA-Z0-9._-]/g, "-")}`);
}
async function removeIntegration(repo: string, pathname: string): Promise<void> {
  try { await exec(["worktree", "remove", "--force", pathname], repo); } catch { /* crash residue */ }
  fs.rmSync(pathname, { recursive: true, force: true });
  try { await exec(["worktree", "prune"], repo); } catch { /* best effort */ }
}
async function conflictFiles(worktree: string): Promise<string[]> {
  try { return (await exec(["diff", "--name-only", "--diff-filter=U"], worktree))
    .stdout.trim().split("\n").filter(Boolean); } catch { return []; }
}
async function integrate(repo: string, op: GitIntegrationOperation, targetSha: string,
  sourceRef: string): Promise<{ resultSha?: string; conflicts?: string[]; error?: string }> {
  const temp = integrationPath(repo, op.id); await removeIntegration(repo, temp);
  fs.mkdirSync(path.dirname(temp), { recursive: true });
  await exec(["worktree", "add", "--detach", temp, targetSha], repo);
  try {
    await exec(["merge", "--no-ff", "--no-edit", sourceRef,
      "-m", `minions: ${op.kind} ${op.id}`], temp);
    return { resultSha: (await exec(["rev-parse", "HEAD"], temp)).stdout.trim() };
  } catch (error) {
    const conflicts = await conflictFiles(temp);
    try { await exec(["merge", "--abort"], temp); } catch { /* already clean */ }
    return { conflicts, error: error instanceof Error ? error.message : String(error) };
  } finally { await removeIntegration(repo, temp); }
}
async function promote(repo: string, targetRef: string, expected: string,
  resultSha: string): Promise<boolean> {
  const checkout = await targetCheckout(repo, targetRef);
  if (checkout) {
    if (await dirty(checkout)) return false;
    await exec(["merge", "--ff-only", resultSha], checkout); return true;
  }
  await exec(["update-ref", fullRef(targetRef), resultSha, expected], repo); return true;
}
export async function cleanupIntegratedContribution(op: GitIntegrationOperation,
  sourceSha: string, targetSha: string): Promise<boolean> {
  const repo = fs.realpathSync(op.repositoryPath);
  if (op.kind !== "integrate_contribution" || !await ancestor(repo, sourceSha, targetSha)) return false;
  let currentSource: string;
  try { currentSource = await sha(repo, op.sourceRef); }
  catch { return !op.worktreePath || !fs.existsSync(op.worktreePath); }
  if (currentSource !== sourceSha) return false;
  if (op.worktreePath && fs.existsSync(op.worktreePath)) {
    if (await dirty(op.worktreePath)) return false;
    try { await exec(["worktree", "remove", "--force", op.worktreePath], repo); } catch { return false; }
  }
  try { await exec(["update-ref", "-d", fullRef(op.sourceRef), sourceSha], repo); }
  catch { return false; }
  return true;
}

export async function executeGitIntegration(op: GitIntegrationOperation,
  options: GitIntegrationExecutorOptions = {}): Promise<GitIntegrationResult> {
  const repo = fs.realpathSync(op.repositoryPath); const targetRef = fullRef(op.targetRef);
  const sourceRef = fullRef(op.sourceRef); await exec(["check-ref-format", targetRef], repo);
  await exec(["check-ref-format", sourceRef], repo);
  if (op.kind === "integrate_contribution" && op.targetWorktreePath) {
    await provisionPlannedWorktree({ path: op.targetWorktreePath,
      branch: targetRef.slice("refs/heads/".length), projectPath: repo,
      leaderSessionKey: op.lineageId ?? op.id, createdAt: Date.now() }, op.expectedTargetSha);
  }
  if (op.worktreePath && await dirty(op.worktreePath)) return { status: "failed",
    error: "contribution changed after review; collect and review a new source head" };
  const sourceSha = await sha(repo, sourceRef); let targetSha = await sha(repo, targetRef);
  if (sourceSha !== op.expectedSourceSha) return { status: "failed", targetSha, sourceSha,
    error: `source head changed after review: expected ${op.expectedSourceSha}, found ${sourceSha}` };
  if (!await ancestor(repo, op.expectedTargetSha, targetSha)) return { status: "failed",
    targetSha, sourceSha, error: "target history no longer contains the queued audit baseline" };
  let targetMoved = targetSha !== op.expectedTargetSha;
  if (await ancestor(repo, sourceSha, targetSha)) {
    return { status: "succeeded", targetSha, resultSha: targetSha, sourceSha,
      headReachable: true, cleaned: false, recovered: true, targetMoved };
  }
  const retries = op.maxTargetRetries ?? 3;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (!await ancestor(repo, op.expectedTargetSha, targetSha)) return { status: "failed",
      targetSha, sourceSha, error: "target history was rewritten after the operation was queued" };
    const checkout = await targetCheckout(repo, targetRef);
    if (checkout && await dirty(checkout)) return { status: "waiting", targetSha, sourceSha,
      error: `target checkout is dirty: ${checkout}` };
    const gateContext: GitGateContext = { operation: op, targetSha, sourceSha, attempt };
    if (op.kind === "promote_lineage" && options.evaluateGate) {
      const verdict = await options.evaluateGate(gateContext);
      await options.onGateEvaluated?.(gateContext, verdict);
      if (!verdict.allowed) return { status: "failed", targetSha, sourceSha,
        error: verdict.reason ?? "promotion gates failed" };
    } else if (op.kind === "promote_lineage") {
      return { status: "failed", targetSha, sourceSha,
        error: "promotion requires a configured final gate evaluator" };
    }
    // Merge the immutable reviewed object ID, never the movable source ref.
    const merged = await integrate(repo, op, targetSha, sourceSha);
    if (!merged.resultSha) return { status: "conflicted", targetSha, sourceSha,
      conflicts: merged.conflicts ?? [], preservedPaths: op.worktreePath ? [op.worktreePath] : [],
      error: merged.error ?? "integration conflicted" };
    await options.beforePromote?.({ ...gateContext, resultSha: merged.resultSha });
    const current = await sha(repo, targetRef);
    if (current !== targetSha) { targetSha = current; targetMoved = true; continue; }
    await options.beforeUpdateRef?.({ ...gateContext, resultSha: merged.resultSha });
    try {
      if (!await promote(repo, targetRef, targetSha, merged.resultSha)) return {
        status: "waiting", targetSha, sourceSha, error: "target checkout became dirty before promotion" };
    } catch (error) {
      const moved = await sha(repo, targetRef);
      if (moved !== targetSha) { targetSha = moved; targetMoved = true; continue; }
      return { status: "failed", targetSha, sourceSha,
        error: error instanceof Error ? error.message : String(error) };
    }
    await options.afterPromote?.({ ...gateContext, resultSha: merged.resultSha });
    const resultSha = await sha(repo, targetRef);
    if (!await ancestor(repo, sourceSha, resultSha)) return { status: "failed", targetSha,
      sourceSha, error: "promoted target does not contain source head" };
    return { status: "succeeded", targetSha: resultSha, resultSha, sourceSha,
      headReachable: true, cleaned: false, recovered: false, targetMoved };
  }
  return { status: "waiting", targetSha, sourceSha,
    error: "target moved repeatedly during integration; operation requeued" };
}
