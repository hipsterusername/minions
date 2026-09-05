import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { ensureWorktreeIntegrationSchema } from "./worktree-integration-schema.ts";
import { createWorkItem } from "./work-item-repo.ts";
import * as rows from "./worktree-integration-repo.ts";
import { SqliteWorktreeIntegrationService } from "./worktree-integration-sqlite.ts";
import { provisionPlannedWorktree } from "./worktree-create.ts";
import { createProductionGitIntegrationWorker } from "./git-integration-worker.ts";
import { createSqliteGitIntegrationStore } from "./sqlite-git-integration-store.ts";
import { captureEvidenceBinding } from "./system-model/evidence-binding.ts";
import { prepareGitResolution } from "./git-resolution.ts";
import { cleanupTerminalWorktrees } from "./worktree-cleanup.ts";
import type { WorkPacket } from "../shared/system-model/index.ts";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", args, { cwd })).stdout.trim();
let root: string, repo: string, db: ReturnType<typeof initDb>, service: SqliteWorktreeIntegrationService;
let tick: number;
const packet = { id: "wp_audit", leaderSessionKey: "one", createdAt: 1, userRequest: "test", normalizedGoal: "test", status: "active",
  scope: { capabilities: [], flows: [], constraints: [], decisions: [], risks: [], suggestedFiles: [], suggestedTests: [] },
  nonGoals: [], agentInstructions: [], freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
  reviewGates: [], riskLevel: "high", matchConfidence: "high", amendments: [] } as WorkPacket;
const contribution = (run: string) => rows.findContributionByRun(db, run)!;
const lineage = (run = "one") => rows.getLineage(db, contribution(run).lineage_id)!;
const worker = () => createProductionGitIntegrationWorker(createSqliteGitIntegrationStore(db), {
  evaluateGate: async () => ({ allowed: true }), onGateEvaluated: async () => {},
});
async function start(run: string, workItemId = "work") {
  const plan = await service.bindRun({ workItemId, runKey: run });
  await provisionPlannedWorktree(plan); service.transitionProvisioning(run, "active"); return plan;
}
async function approve(run: string) {
  const row = contribution(run);
  await service.reviewContribution({ requestId: `review-${run}-${tick++}`, contributionId: row.id,
    expectedRevision: row.revision, decision: "approved", actor: "user", summary: "checked" });
  const current = contribution(run);
  await service.enqueueContribution({ requestId: `queue-${run}-${tick++}`, contributionId: row.id, expectedRevision: current.revision });
}
async function promote() {
  let row = lineage();
  await service.reviewFinal({ requestId: `final-${tick++}`, lineageId: row.id,
    expectedRevision: row.revision, decision: "approved", actor: "user", summary: "verified" });
  row = lineage();
  await service.promote({ requestId: `promote-${tick++}`, lineageId: row.id, expectedRevision: row.revision });
  return worker().runNext(repo, row.target_ref);
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-lifecycle-"));
  vi.stubEnv("MINIONS_HOME", path.join(root, "state")); vi.stubEnv("DB_PATH", path.join(root, "server.db"));
  repo = path.join(root, "repo"); fs.mkdirSync(repo); tick = 10;
  await git(repo, "init", "-b", "main"); await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid"); await git(repo, "config", "commit.gpgsign", "false");
  await git(repo, "config", "core.hooksPath", "/dev/null");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".canvas-worktrees/\n"); fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
  db = initDb(":memory:"); ensureWorkItemSchema(db); ensureWorktreeIntegrationSchema(db);
  createWorkItem(db, { id: "work", projectId: "project", projectPath: repo, title: "Test", changeMode: "worktree", at: 1 });
  service = new SqliteWorktreeIntegrationService(db, () => tick++, undefined, undefined, undefined,
    async () => ({ allowed: true, mode: "off", gates: [] }));
});
afterEach(() => { db?.close(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe("worktree lifecycle with asynchronous real Git", () => {
  it("keeps evidence through collection, provisions the integrated base, discards and promotes with cleanup", async () => {
    const first = await start("one"); fs.writeFileSync(path.join(first.path, "feature.txt"), "feature\n");
    const digest = await captureEvidenceBinding(first.path, packet, null, repo);
    await service.collectRun("one", "completed");
    expect(await captureEvidenceBinding(first.path, packet, null, repo)).toBe(digest);
    fs.writeFileSync(path.join(first.path, "feature.txt"), "changed\n");
    expect(await captureEvidenceBinding(first.path, packet, null, repo)).not.toBe(digest);
    fs.writeFileSync(path.join(first.path, "feature.txt"), "feature\n");
    await approve("one"); expect(await worker().runNext(repo, lineage().integration_ref)).toMatchObject({ status: "succeeded", cleaned: true });
    const second = await start("two");
    expect(await git(second.path, "rev-parse", "HEAD")).toBe(contribution("two").base_sha);
    expect(fs.readFileSync(path.join(second.path, "feature.txt"), "utf8")).toBe("feature\n");
    const row = contribution("two");
    await service.discardContribution({ requestId: "discard", contributionId: row.id, expectedRevision: row.revision });
    expect(fs.existsSync(second.path)).toBe(false); expect(contribution("two").cleanup_state).toBe("cleaned");
    const integrationPath = lineage().integration_worktree_path;
    expect(await promote()).toMatchObject({ status: "succeeded", cleaned: true });
    expect(fs.existsSync(integrationPath)).toBe(false); expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(true);
  });

  it("starts from an explicitly chosen target even when another branch is checked out", async () => {
    await git(repo, "checkout", "-b", "release");
    fs.writeFileSync(path.join(repo, "release.txt"), "release\n"); await git(repo, "add", "."); await git(repo, "commit", "-m", "release");
    await git(repo, "checkout", "main");
    await service.createLineage({ requestId: "release-lineage", workItemId: "work", targetBranch: "release" });
    const plan = await start("one"); expect(fs.existsSync(path.join(plan.path, "release.txt"))).toBe(true);
  });

  it("requires a resolution and new review when the target advances, then promotes the verified combination", async () => {
    const plan = await start("one"); fs.writeFileSync(path.join(plan.path, "feature.txt"), "feature\n");
    await service.collectRun("one", "completed"); await approve("one"); await worker().runNext(repo, lineage().integration_ref);
    fs.writeFileSync(path.join(repo, "target.txt"), "new target\n"); await git(repo, "add", "."); await git(repo, "commit", "-m", "target moved");
    expect(await promote()).toMatchObject({ status: "conflicted", error: expect.stringContaining("unreviewed") });
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
    const resolution = await service.bindRun({ workItemId: "work", runKey: "resolution" });
    expect(resolution.resolutionKind).toBe("lineage");
    await prepareGitResolution({ repositoryPath: repo, worktreePath: resolution.path,
      sourceRef: resolution.branch, targetRef: resolution.resolutionTargetRef! });
    await service.collectRun("resolution", "completed");
    expect(await promote()).toMatchObject({ status: "succeeded" });
    expect(fs.existsSync(path.join(repo, "target.txt"))).toBe(true); expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(true);
  });

  async function conflictingContributions() {
    const first = await start("one");
    createWorkItem(db, { id: "other", projectId: "project", projectPath: repo, title: "Other", changeMode: "worktree", at: 2 });
    const line = lineage(); await service.joinLineage({ requestId: "join", workItemId: "other", lineageId: line.id, expectedRevision: line.revision, actor: "user" });
    const second = await start("two", "other");
    fs.writeFileSync(path.join(first.path, "base.txt"), "first\n"); fs.writeFileSync(path.join(second.path, "base.txt"), "second\n");
    await service.collectRun("one", "completed"); await service.collectRun("two", "completed");
    await approve("one"); await worker().runNext(repo, lineage().integration_ref);
    await approve("two"); expect(await worker().runNext(repo, lineage().integration_ref)).toMatchObject({ status: "conflicted" });
    return second;
  }
  it.each(["ours", "theirs"] as const)("executes %s conflict resolution and requires another approval", async (strategy) => {
    const second = await conflictingContributions(); const row = contribution("two");
    const queue = rows.getLineageState(db, row.lineage_id).queue.find(entry => entry.contribution_id === row.id)!;
    const input = { requestId: "resolve", contributionId: row.id, queueId: queue.id, expectedRevision: row.revision,
      strategy, actor: "user", reason: "chosen" };
    await service.resolveConflict(input); await service.resolveConflict(input);
    expect(contribution("two")).toMatchObject({ state: "ready", review_state: "pending" });
    expect(fs.readFileSync(path.join(second.path, "base.txt"), "utf8")).toBe(strategy === "ours" ? "second\n" : "first\n");
    await approve("two"); expect(await worker().runNext(repo, lineage().integration_ref)).toMatchObject({ status: "succeeded" });
  });
  it("lets an agent resolve files without Git writes and refuses to collect unresolved markers", async () => {
    const second = await conflictingContributions();
    const plan = await service.bindRun({ workItemId: "other", runKey: "manual" });
    await prepareGitResolution({ repositoryPath: repo, worktreePath: plan.path, sourceRef: plan.branch, targetRef: plan.resolutionTargetRef! });
    await expect(service.collectRun("manual", "completed")).rejects.toThrow("Unresolved conflict");
    fs.writeFileSync(path.join(second.path, "base.txt"), "combined\n");
    await service.collectRun("manual", "completed");
    expect(await git(second.path, "status", "--porcelain")).toBe("");
    expect((await git(second.path, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ")).toHaveLength(3);
  });
  it("retains dirty integrated worktrees and retries cleanup after they become clean", async () => {
    const first = await start("one"); fs.writeFileSync(path.join(first.path, "feature.txt"), "feature\n");
    await service.collectRun("one", "completed"); await approve("one");
    const retainedWorker = createProductionGitIntegrationWorker(createSqliteGitIntegrationStore(db), {
      evaluateGate: async () => ({ allowed: true }), onGateEvaluated: async () => {},
      onDurableTransition: ({ phase }) => { if (phase === "finished") fs.writeFileSync(path.join(first.path, "late.txt"), "retain\n"); },
    });
    expect(await retainedWorker.runNext(repo, lineage().integration_ref)).toMatchObject({ status: "succeeded", cleaned: false });
    await cleanupTerminalWorktrees(db); expect(fs.existsSync(first.path)).toBe(true);
    fs.unlinkSync(path.join(first.path, "late.txt")); await cleanupTerminalWorktrees(db);
    expect(fs.existsSync(first.path)).toBe(false); expect(contribution("one").cleanup_state).toBe("cleaned");
  });
});
