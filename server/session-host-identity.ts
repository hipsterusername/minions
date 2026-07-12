import type { NormalizedEvent } from "./harness/types.ts";
import type { BufferedEvent } from "./session-host-config.ts";
import type { SessionRunKind, WorkItemRuntimeLifecycle } from "./session-host-types.ts";

export interface SessionHostIdentity {
  id: string;
  runKey: string;
  workItemId: string | null;
  runKind: "primary" | "child";
  parentRunKey: string | null;
  taskId: string | null;
}

interface MutableSessionRunLineage extends SessionHostIdentity {
  runLineageSeeded: boolean;
}

interface RuntimeTerminalHost extends SessionHostIdentity {
  runtimeTerminalNotified: boolean;
  runtimeTerminalInFlight: boolean;
}

export function notifyRuntimeTerminal(
  host: RuntimeTerminalHost,
  lifecycle: WorkItemRuntimeLifecycle | undefined,
  terminal: { outcome: "completed" | "error" | "interrupted"; finalReportId: string | null; finalReport: string | null; at: number },
): boolean {
  if (!host.workItemId || !lifecycle || host.runtimeTerminalNotified
    || host.runtimeTerminalInFlight) return false;
  host.runtimeTerminalInFlight = true;
  try {
    lifecycle.runTerminal({
      workItemId: host.workItemId, runKey: host.runKey, runKind: host.runKind,
      parentRunKey: host.parentRunKey, taskId: host.taskId, ...terminal,
    });
    host.runtimeTerminalNotified = true;
    return true;
  } finally {
    host.runtimeTerminalInFlight = false;
  }
}

/** Seed immutable primary/child lineage once; later omissions preserve it. */
export function seedSessionRunLineage(
  host: MutableSessionRunLineage,
  input: { runKind?: SessionRunKind; parentRunKey?: string | null; taskId?: string | null },
): boolean {
  const runKind = input.runKind ?? "primary";
  const parentRunKey = input.parentRunKey ?? null;
  const taskId = input.taskId ?? null;
  if (runKind === "primary" && (parentRunKey !== null || taskId !== null)) return false;
  if (runKind === "child" && (parentRunKey === null || taskId === null)) return false;
  if (!host.runLineageSeeded) {
    host.runKind = runKind;
    host.parentRunKey = parentRunKey;
    host.taskId = taskId;
    host.runLineageSeeded = true;
    return true;
  }
  return host.runKind === runKind
    && host.parentRunKey === parentRunKey
    && host.taskId === taskId;
}

/** Stable correlation fields for every SessionHost-owned log record. */
export function sessionHostLogFields(host: SessionHostIdentity): {
  sessionKey: string;
  runKey: string;
  workItemId: string | null;
  runKind: "primary" | "child";
  parentRunKey: string | null;
  taskId: string | null;
} {
  return {
    sessionKey: host.id,
    runKey: host.runKey,
    workItemId: host.workItemId,
    runKind: host.runKind,
    parentRunKey: host.parentRunKey,
    taskId: host.taskId,
  };
}

/** Add canonical identity at the normalized-event boundary. */
export function normalizedEventEnvelope(
  host: SessionHostIdentity,
  event: NormalizedEvent,
  timestamp = Date.now(),
): BufferedEvent {
  return {
    type: "sdk_event",
    sessionKey: host.id,
    runKey: host.runKey,
    workItemId: host.workItemId,
    event,
    timestamp,
  };
}
