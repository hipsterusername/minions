import type { MobileSessionInfo } from "./mobile-selectors.ts";

/**
 * The three lifecycle transitions the Activity triage lane can drive on a
 * session: mark it reviewed (acknowledge), hide it (dismiss), or bring a
 * dismissed session back (reopen). These mirror the desktop Activity inspector
 * so both surfaces resolve attention through the same server commands.
 */
export type LifecycleAction = "acknowledge" | "dismiss" | "reopen";

/**
 * A session that lives under a canonical Work Item routes through the
 * work-item commands (which fence on the current run); a bare session routes
 * through the session-scoped commands. Same intent, different envelope.
 */
const COMMAND_TYPES: Record<LifecycleAction, { workItem: string; session: string }> = {
  acknowledge: { workItem: "review_work_item", session: "acknowledge_session" },
  dismiss: { workItem: "archive_work_item", session: "dismiss_session" },
  reopen: { workItem: "restore_work_item", session: "reopen_session" },
};

/**
 * Build the WS command that applies `action` to `session`. Pure: the caller
 * supplies `requestId` (so tests stay deterministic and the component passes a
 * fresh UUID per click). Shapes match `ActivityView`'s inspector exactly.
 *
 * The work-item envelope is used only for canonical entries, whose
 * `reviewLifecycle.lifecycleRevision` is the work item's revision counter. A
 * session that references a work item without being canonical (e.g. an orphan
 * whose item is missing from the loaded list) carries the session's own
 * revision counter — sending that to a work-item command trips the server's
 * "stale work-item lifecycle" fence. Those route through the session-scoped
 * commands, which re-read authoritative work-item state server-side.
 */
export function buildLifecycleCommand(
  action: LifecycleAction,
  session: MobileSessionInfo,
  requestId: string,
): Record<string, unknown> {
  const expectedLifecycleRevision = session.reviewLifecycle?.lifecycleRevision ?? 0;
  if (session.workItemId && session.canonicalWorkItem) {
    return {
      type: COMMAND_TYPES[action].workItem,
      workItemId: session.workItemId,
      requestId,
      expectedCurrentRunKey: session.sessionKey.startsWith("work-item:")
        ? null
        : session.sessionKey,
      expectedLifecycleRevision,
    };
  }
  return {
    type: COMMAND_TYPES[action].session,
    sessionKey: session.sessionKey,
    expectedLifecycleRevision,
  };
}

/** Whether the "Mark reviewed" action applies to a session's current state. */
export function canAcknowledge(session: MobileSessionInfo): boolean {
  const lifecycle = session.reviewLifecycle;
  return (
    !!lifecycle &&
    lifecycle.reviewState !== "none" &&
    lifecycle.acknowledgedAt == null &&
    lifecycle.dismissedAt == null
  );
}

/** Whether a session is currently dismissed (so the action is "Restore"). */
export function isDismissed(session: MobileSessionInfo): boolean {
  return session.reviewLifecycle?.dismissedAt != null;
}
