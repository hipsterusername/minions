import crypto from "node:crypto";
import fs from "node:fs";
import { cleanupIntegratedContribution, executeGitIntegration } from "./git-integration-executor.ts";
import type { GitIntegrationExecutorOptions, GitIntegrationOperation,
  GitIntegrationResult, GitIntegrationStore } from "./git-integration-types.ts";

/** Process-local ordering; durable claim + update-ref CAS remain correctness boundaries. */
const scopedTails = new Map<string, Promise<void>>();
async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = scopedTails.get(key) ?? Promise.resolve(); let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.catch(() => undefined).then(() => tail);
  scopedTails.set(key, queued);
  await prior.catch(() => undefined);
  try { return await task(); }
  finally { release(); if (scopedTails.get(key) === queued) scopedTails.delete(key); }
}

export interface GitIntegrationWorkerOptions extends GitIntegrationExecutorOptions {
  workerId?: string;
  onDurableTransition?: (event: { phase: "requeued" | "finished" | "cleaned" | "cleanup_deferred";
    operation: GitIntegrationOperation; result: GitIntegrationResult }) => void | Promise<void>;
}
export type ProductionGitIntegrationWorkerOptions = GitIntegrationWorkerOptions &
  Required<Pick<GitIntegrationExecutorOptions, "evaluateGate" | "onGateEvaluated">>;

export class GitIntegrationWorker {
  readonly workerId: string;
  constructor(private readonly store: GitIntegrationStore,
    private readonly options: GitIntegrationWorkerOptions = {}) {
    this.workerId = options.workerId ?? `git-worker-${crypto.randomUUID()}`;
  }

  async runNext(repositoryPath: string, targetRef: string): Promise<GitIntegrationResult | null> {
    const repo = fs.realpathSync(repositoryPath); const scope = `${repo}\0${targetRef}`;
    return serialized(scope, async () => {
      const entry = await this.store.claimNext(repo, targetRef, this.workerId);
      if (!entry) return null;
      return this.executeClaimed(entry);
    });
  }

  async executeClaimed(entry: GitIntegrationOperation): Promise<GitIntegrationResult> {
    const claim = { workerId: this.workerId, fenceToken: entry.fenceToken };
    let result: GitIntegrationResult;
    try { result = await executeGitIntegration(entry, this.options); }
    catch (error) {
      result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === "waiting") {
      await this.store.requeue(entry.id, result.error, claim);
      await this.notify("requeued", entry, result); return result;
    }
    if (result.status === "succeeded") {
      await this.store.finish(entry.id, "succeeded", { resultSha: result.resultSha }, claim);
      await this.notify("finished", entry, result);
      const cleaned = await cleanupIntegratedContribution(entry, result.sourceSha, result.resultSha);
      if (cleaned && entry.contributionId && this.store.markCleaned) {
        await this.store.markCleaned(entry.contributionId, { headReachable: true,
          queueId: entry.id, resultSha: result.resultSha }, claim);
      }
      const cleanedResult = { ...result, cleaned };
      await this.notify(cleaned ? "cleaned" : "cleanup_deferred", entry, cleanedResult);
      return cleanedResult;
    }
    await this.store.finish(entry.id, result.status,
      { error: result.error, ...("targetSha" in result && result.targetSha
        ? { resultSha: result.targetSha } : {}), ...(result.status === "conflicted"
        ? { conflictDetails: { conflicts: result.conflicts, preservedPaths: result.preservedPaths,
          targetSha: result.targetSha, sourceSha: result.sourceSha } } : {}) }, claim);
    await this.notify("finished", entry, result);
    return result;
  }
  private async notify(phase: "requeued" | "finished" | "cleaned" | "cleanup_deferred",
    operation: GitIntegrationOperation, result: GitIntegrationResult) {
    try { await this.options.onDurableTransition?.({ phase, operation, result }); }
    catch { /* reconnect snapshots remain authoritative if an observer fails */ }
  }
}

export function createProductionGitIntegrationWorker(store: GitIntegrationStore,
  options: ProductionGitIntegrationWorkerOptions): GitIntegrationWorker {
  return new GitIntegrationWorker(store, { ...options, requireReviewedTargetInSource: true });
}

export type { GitIntegrationOperation, GitIntegrationResult, GitIntegrationStore }
  from "./git-integration-types.ts";
export { executeGitIntegration } from "./git-integration-executor.ts";
