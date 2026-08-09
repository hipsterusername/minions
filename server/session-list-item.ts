/**
 * SessionListItem — the compact per-session shape broadcast to clients in
 * `session_list` messages, plus the pure builder that derives it from a
 * live SessionHost. Separate ownership keeps the registry focused on host
 * lifecycle and under the server file-size cap.
 */

import type { SessionHost, SessionRole, SessionStatus } from "./session-host.ts";
import { getHarness } from "./harness/index.ts";
import type { HarnessCapabilities } from "./harness/types.ts";
import type { SessionUsageTotals } from "./usage-telemetry.ts";
import type { SessionReviewLifecycle } from "./session-review-lifecycle.ts";
import { findWorkspaceBySource } from "./workspace-registry.ts";

/** Compact shape broadcast to clients in `session_list` messages. */
export interface SessionListItem {
  sessionKey: string;
  runKey?: string;
  workItemId?: string | null;
  runKind?: "primary" | "child";
  parentRunKey?: string | null;
  taskId?: string | null;
  sessionId: string | null;
  status: SessionStatus;
  cwd: string;
  /** Stable workspace UUID when the session can be associated with one. */
  projectId?: string;
  totalCost: number;
  turns: number;
  usageTotals: SessionUsageTotals;
  model: string | null;
  permissionMode: string | null;
  taskName: string | null;
  role: SessionRole;
  /**
   * Registered harness driving this session. Mirrors the field on
   * `sync_response` so the sessions panel can render harness-aware
   * affordances without an extra round-trip per session.
   */
  harness: string;
  /**
   * Capabilities of the resolved harness, or `null` when the harness
   * name is no longer registered (e.g. a hydrated session whose harness
   * module has been removed). Clients treat `null` as "fall back to safe
   * defaults" rather than throwing.
   */
  harnessCapabilities: HarnessCapabilities | null;
  /**
   * Timestamp for the most recent assistant response when available, falling
   * back to the most recent buffered event. Used by Activity views to keep
   * stopped/hydrated sessions sorted by recent engagement.
   */
  lastActivityAt: number | null;
  reviewLifecycle?: SessionReviewLifecycle;
  activeMinions: Array<{
    taskId: string;
    title: string;
    status: string;
    sessionKey: string | null;
  }>;
}

export function lastResponseOrActivityAt(
  events: ReadonlyArray<{ timestamp?: unknown; type?: unknown; event?: unknown }>,
): number | null {
  const lastAssistantResponse = [...events]
    .reverse()
    .find((event) => {
      const payload = event.event;
      return (
        event.type === "sdk_event" &&
        typeof payload === "object" &&
        payload !== null &&
        (payload as { kind?: unknown }).kind === "text" &&
        (payload as { role?: unknown }).role === "assistant" &&
        typeof event.timestamp === "number"
      );
    });
  if (typeof lastAssistantResponse?.timestamp === "number") {
    return lastAssistantResponse.timestamp;
  }

  const lastTimestampedEvent = [...events]
    .reverse()
    .find((event) => typeof event.timestamp === "number");
  return typeof lastTimestampedEvent?.timestamp === "number"
    ? lastTimestampedEvent.timestamp
    : null;
}

function harnessMeta(name: string): {
  harness: string;
  harnessCapabilities: HarnessCapabilities | null;
} {
  try {
    return { harness: name, harnessCapabilities: getHarness(name).capabilities };
  } catch {
    return { harness: name, harnessCapabilities: null };
  }
}

/** Derive the broadcastable list item for one live host. */
export function buildSessionListItem(key: string, s: SessionHost): SessionListItem {
  const { harness, harnessCapabilities } = harnessMeta(s.harnessName);
  const lastActivityAt = lastResponseOrActivityAt(s.eventBuffer);
  let projectId: string | undefined;
  try {
    projectId = findWorkspaceBySource(s.worktree?.projectPath ?? s.cwd)?.id;
  } catch {
    // A malformed registry blocks workspace mutation, but must not make the
    // global session list unavailable while the user repairs it.
  }
  return {
    sessionKey: key,
    runKey: s.runKey,
    workItemId: s.workItemId,
    runKind: s.runKind,
    parentRunKey: s.parentRunKey,
    taskId: s.taskId,
    sessionId: s.sessionId,
    status: s.status,
    cwd: s.cwd,
    ...(projectId ? { projectId } : {}),
    totalCost: s.totalCost,
    turns: s.turns,
    usageTotals: s.usageTotals,
    model: s.model,
    permissionMode: s.permissionMode,
    taskName: s.taskName,
    role: s.role,
    harness,
    harnessCapabilities,
    lastActivityAt,
    reviewLifecycle: s.reviewLifecycle,
    activeMinions: s.taskState
      ? Array.from(s.taskState.tasks.entries())
          .filter(
            ([, t]) =>
              t.status === "planned" ||
              t.status === "starting" ||
              t.status === "running" ||
              t.status === "blocked",
          )
          .map(([id, t]) => ({
            taskId: id,
            title: t.title,
            status: t.status,
            sessionKey: t.minionSessionKey,
          }))
      : [],
  };
}
