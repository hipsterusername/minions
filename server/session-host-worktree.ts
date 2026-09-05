import { prepareGitResolution } from "./git-resolution.ts";
import type { AgentType } from "./agents/index.ts";
import type { Bus } from "./bus.ts";
import { createWorktree, isGitRepo, provisionPlannedWorktree } from "./worktree.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import type { SessionHostDeps } from "./session-host-types.ts";
import { sessionHostLogFields } from "./session-host-identity.ts";
import { serverLogger } from "./logging.ts";
const log = serverLogger.child("session-host-worktree");

/** Resolve the effective cwd/worktree before opening the SDK query. */
export async function ensureWorktree(
  host: SessionHost,
  opts: StartSessionOptions,
  bus: Bus,
  agentType: AgentType,
): Promise<string> {
  let effectiveCwd = opts.cwd;

  if (opts.parentWorktree) {
    host.worktree = opts.parentWorktree;
    host.cwd = opts.parentWorktree.path;
    effectiveCwd = opts.parentWorktree.path;
    log.debug("parent_worktree_inherited", { ...sessionHostLogFields(host), branch: opts.parentWorktree.branch, worktreePath: opts.parentWorktree.path });
  } else {
    host.cwd = effectiveCwd;
  }

  if (!(agentType.wantsWorktree && host.worktreeIsolation)) {
    return effectiveCwd;
  }

  if (host.worktree && !opts.parentWorktree) {
    host.cwd = host.worktree.path;
    return host.worktree.path;
  }

  if (opts.parentWorktree) return effectiveCwd;

  try {
    const inGitRepo = await isGitRepo(effectiveCwd);
    if (!inGitRepo) throw new Error("Worktree isolation requires a Git repository");
    const worktreeInfo = opts.plannedContribution
      ? await provisionPlannedWorktree(opts.plannedContribution)
      : await createWorktree(effectiveCwd, host.id);
    host.worktree = worktreeInfo;
    host.cwd = worktreeInfo.path;
    bus.emitToSession(host.id, {
      type: "worktree_created",
      sessionKey: host.id,
      worktreePath: worktreeInfo.path,
      branch: worktreeInfo.branch,
    });
    log.info("worktree_created", { ...sessionHostLogFields(host), branch: worktreeInfo.branch, worktreePath: worktreeInfo.path });
    effectiveCwd = worktreeInfo.path;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("worktree_create_failed", { ...sessionHostLogFields(host), error: err });
    bus.emitToSession(host.id, {
      type: "worktree_failed",
      sessionKey: host.id,
      error: `Worktree creation failed: ${errMsg}`,
    });
    // Isolation is a safety boundary, especially for harnesses whose mutation
    // interception is observe-only. Never downgrade a requested worktree run
    // into a shared-directory writer when provisioning fails.
    throw err;
  }
  return effectiveCwd;
}
export async function ensureContributionWorktree(host: SessionHost, opts: StartSessionOptions, bus: Bus,
  agentType: AgentType, transition?: SessionHostDeps["transitionWorktreeProvisioning"]): Promise<void> {
  transition?.(host.runKey, "provisioning");
  try {
    await ensureWorktree(host, opts, bus, agentType);
    if (opts.plannedContribution?.resolutionTargetRef && host.worktree) await prepareGitResolution({
      repositoryPath: host.worktree.projectPath, worktreePath: host.worktree.path,
      sourceRef: host.worktree.branch, targetRef: opts.plannedContribution.resolutionTargetRef });
    transition?.(host.runKey, "active");
  }
  catch (error) { transition?.(host.runKey, "failed",
    error instanceof Error ? error.message : String(error)); throw error; }
}
