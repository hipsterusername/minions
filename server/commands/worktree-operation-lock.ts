import type { SessionHost } from "../session-host.ts";

/**
 * Destructive worktree operations must be single-flight per session. Git
 * protects individual ref updates, but it cannot make a merge, discard, and
 * cleanup sequence atomic when two WebSocket commands race each other.
 */
const activeOperations = new WeakMap<SessionHost, string>();
const activePaths = new Map<string, string>();
const executions = new Map<SessionHost, number>();
export function trackWorktreeExecution(host: SessionHost): () => void {
  executions.set(host, (executions.get(host) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    const remaining = (executions.get(host) ?? 1) - 1;
    if (remaining) executions.set(host, remaining); else executions.delete(host);
  };
}

export interface WorktreeOperationLease {
  readonly command: string;
  release(): void;
}

export function beginWorktreeOperation(
  host: SessionHost,
  command: string,
): WorktreeOperationLease | null {
  if (worktreeBusyReason(host)) return null;
  activeOperations.set(host, command);
  const pathname = host.worktree?.path;
  if (pathname) activePaths.set(pathname, command);

  let released = false;
  return {
    command,
    release() {
      if (released) return;
      released = true;
      if (activeOperations.get(host) === command) {
        activeOperations.delete(host);
        if (pathname) activePaths.delete(pathname);
      }
    },
  };
}

export function worktreeBusyReason(host: SessionHost): string | null {
  if ([...executions.keys()].some(other => other === host || (host.worktree && other.worktree?.path === host.worktree.path))
    || host.status === "running" || host.runControl || host.eventStream
    || [...(host.taskState?.tasks.values() ?? [])].some(task => ["running", "assigned"].includes(task.status)))
    return "agent execution (stop and wait for it to finish)";
  return activeOperations.get(host) ?? (host.worktree ? activePaths.get(host.worktree.path) : null) ?? null;
}

export function hasWorktreeOperation(host: SessionHost, pathname = host.worktree?.path): boolean {
  return activeOperations.has(host) || Boolean(pathname && activePaths.has(pathname));
}

export function activeWorktreeOperation(host: SessionHost): string | null { return activeOperations.get(host) ?? null; }

export function worktreePathBusy(pathname: string): boolean {
  return activePaths.has(pathname) || [...executions.keys()].some(host => host.worktree?.path === pathname);
}
