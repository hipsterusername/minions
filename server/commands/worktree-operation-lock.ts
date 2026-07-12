import type { SessionHost } from "../session-host.ts";

/**
 * Destructive worktree operations must be single-flight per session. Git
 * protects individual ref updates, but it cannot make a merge, discard, and
 * cleanup sequence atomic when two WebSocket commands race each other.
 */
const activeOperations = new WeakMap<SessionHost, string>();

export interface WorktreeOperationLease {
  readonly command: string;
  release(): void;
}

export function beginWorktreeOperation(
  host: SessionHost,
  command: string,
): WorktreeOperationLease | null {
  if (activeOperations.has(host)) return null;
  activeOperations.set(host, command);

  let released = false;
  return {
    command,
    release() {
      if (released) return;
      released = true;
      if (activeOperations.get(host) === command) {
        activeOperations.delete(host);
      }
    },
  };
}

export function activeWorktreeOperation(host: SessionHost): string | null {
  return activeOperations.get(host) ?? null;
}
