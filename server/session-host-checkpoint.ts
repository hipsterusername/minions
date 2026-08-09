import type { NormalizedEvent } from "./harness/types.ts";
import type { SessionHost, SessionHostDeps, StartSessionOptions } from "./session-host.ts";
import { commitContextCheckpoint, failContextCheckpoint } from "./context-checkpoint.ts";
import { emitSessionCompacted } from "./proactive-compaction.ts";

export function commitCheckpointOnInit(
  host: SessionHost,
  deps: SessionHostDeps,
  opts: StartSessionOptions,
  event: NormalizedEvent,
): boolean {
  const checkpoint = host.contextCheckpoint;
  if (event.kind !== "init" || !opts.contextCheckpointId ||
      checkpoint?.checkpointId !== opts.contextCheckpointId || checkpoint.status !== "prepared") return false;
  commitContextCheckpoint(checkpoint, event.sessionId);
  emitSessionCompacted(host, deps, checkpoint.sourceSessionId, checkpoint.usage);
  return true;
}

export function failUninitializedCheckpoint(
  host: SessionHost,
  opts: StartSessionOptions,
  initialized: boolean,
  reason: string,
): void {
  const checkpoint = host.contextCheckpoint;
  if (!initialized && opts.contextCheckpointId &&
      checkpoint?.checkpointId === opts.contextCheckpointId && checkpoint.status === "prepared") {
    failContextCheckpoint(checkpoint, reason);
  }
}
