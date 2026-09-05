import { useEffect, useRef, useState } from "react";
import { buildLifecycleCommand, type LifecycleAction } from "./mobile/mobile-activity-actions.ts";
import { sessionDisplayTitle, type MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import { activityEntryId } from "./use-work-items.ts";
import { randomUuid } from "./random-id.ts";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import type { SocketSubscribe } from "./use-socket.ts";

const LIFECYCLE_COMMANDS = new Set([
  "review_work_item", "archive_work_item", "restore_work_item",
  "acknowledge_session", "dismiss_session", "reopen_session",
]);

export function lifecycleActionError(msg: unknown): { failed: boolean; error: string } | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { type?: unknown; command?: unknown; success?: unknown; error?: unknown };
  if (m.type !== "work_item_response" && m.type !== "control_response") return null;
  if (typeof m.command !== "string" || !LIFECYCLE_COMMANDS.has(m.command)) return null;
  if (m.success === true) return { failed: false, error: "" };
  if (m.success !== false) return null;
  const verb = m.command.startsWith("review") || m.command.startsWith("acknowledge")
    ? "Mark reviewed"
    : m.command.startsWith("archive") || m.command.startsWith("dismiss") ? "Dismiss" : "Restore";
  const detail = typeof m.error === "string" && m.error.trim()
    ? m.error : "The server rejected the action.";
  return { failed: true, error: `${verb} failed: ${detail}` };
}

interface PendingAction {
  entryId: string;
  command: string;
  envelope: Record<string, unknown>;
  action: LifecycleAction;
  session: MobileSessionInfo;
  timer: ReturnType<typeof setTimeout>;
  timedOut: boolean;
}

/** Keep Canvas side effects behind acknowledgement and correlate bulk outcomes. */
export function useActivityLifecycle({ socketSend, socketSubscribe, onDetachFromCanvas }: {
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
  onDetachFromCanvas?: ((session: Pick<MobileSessionInfo, "sessionKey" | "workItemId">, workItem?: WorkItemSnapshot) => void) | undefined;
}) {
  const [dismissedReceipts, setDismissedReceipts] = useState<MobileSessionInfo[]>([]);
  const requests = useRef(new Map<string, PendingAction>());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const detachRef = useRef(onDetachFromCanvas);
  detachRef.current = onDetachFromCanvas;

  function finish(requestId: string, error?: string, workItem?: WorkItemSnapshot, lifecycle?: MobileSessionInfo["reviewLifecycle"]) {
    const pending = requests.current.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    requests.current.delete(requestId);
    setPendingKeys(new Set([...requests.current.values()].filter((p) => !p.timedOut).map((p) => p.entryId)));
    if (error) {
      setErrors((prev) => ({ ...prev, [pending.entryId]: `${sessionDisplayTitle(pending.session)}: ${error}` }));
    } else {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[pending.entryId];
        return next;
      });
      if (pending.action === "reopen") {
        setDismissedReceipts((prev) => prev.filter((s) => activityEntryId(s) !== pending.entryId));
      }
      if (pending.action === "dismiss") {
        const receipt = { ...pending.session,
          ...(lifecycle ? { reviewLifecycle: lifecycle } : {}),
        };
        if (workItem && workItem.id === receipt.workItemId && receipt.canonicalWorkItem) {
          receipt.sessionKey = workItem.currentRunKey ?? `work-item:${workItem.id}`;
          receipt.reviewLifecycle = { ...receipt.reviewLifecycle!, lifecycleRevision: workItem.lifecycle.lifecycleRevision };
        }
        setDismissedReceipts((prev) => [...prev.filter((s) => activityEntryId(s) !== pending.entryId), receipt]);
        const identity = { sessionKey: pending.session.sessionKey,
          ...(pending.session.workItemId ? { workItemId: pending.session.workItemId } : {}) };
        // The reply's revision is newer than React's state during this socket callback.
        if (workItem && workItem.id === pending.session.workItemId) detachRef.current?.(identity, workItem);
        else detachRef.current?.(identity);
      }
    }
  }

  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe("*", (msg: unknown) => {
      const outcome = lifecycleActionError(msg);
      if (!outcome) return;
      const response = msg as { requestId?: unknown; command?: unknown;
        workItem?: WorkItemSnapshot; lifecycle?: MobileSessionInfo["reviewLifecycle"]; result?: { workItem?: WorkItemSnapshot } };
      if (typeof response.requestId !== "string") return;
      const pending = requests.current.get(response.requestId);
      if (!pending || pending.command !== response.command) return;
      finish(response.requestId, outcome.failed ? outcome.error : undefined,
        response.result?.workItem ?? response.workItem, response.lifecycle);
    });
  }, [socketSubscribe]);

  useEffect(() => () => {
    for (const pending of requests.current.values()) clearTimeout(pending.timer);
    requests.current.clear();
  }, []);

  function sendLifecycle(action: LifecycleAction, session: MobileSessionInfo) {
    const entryId = activityEntryId(session);
    if ([...requests.current.values()].some((p) => p.entryId === entryId && !p.timedOut)) return;
    const retry = [...requests.current.entries()].find(([, pending]) =>
      pending.entryId === entryId && pending.action === action &&
      pending.session.sessionKey === session.sessionKey &&
      pending.session.reviewLifecycle?.lifecycleRevision === session.reviewLifecycle?.lifecycleRevision);
    // New user intent supersedes any late reply to an earlier timed-out action.
    for (const [id, pending] of requests.current) {
      if (pending.entryId === entryId) requests.current.delete(id);
    }
    setErrors((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    if (!socketSend) {
      setErrors((prev) => ({ ...prev, [entryId]: "Activity actions are unavailable. Reconnect and try again." }));
      return;
    }
    // Retrying the same snapshot reuses its idempotency key. If queued sends
    // later arrive together, either successful reply can confirm this intent.
    const requestId = retry?.[0] ?? randomUuid();
    // Session commands also support requestId; keep the shared mobile envelope unchanged.
    const command: Record<string, unknown> = retry?.[1].envelope
      ?? { ...buildLifecycleCommand(action, session, requestId), requestId };
    const timer = setTimeout(() => {
      const pending = requests.current.get(requestId);
      if (!pending) return;
      // Release controls but retain correlation: a disconnected socket can queue sends.
      pending.timedOut = true;
      setPendingKeys(new Set([...requests.current.values()].filter((p) => !p.timedOut).map((p) => p.entryId)));
      setErrors((prev) => ({ ...prev, [entryId]: `${sessionDisplayTitle(session)}: The server has not confirmed the action. Check the connection and try again.` }));
    }, 15_000);
    requests.current.set(requestId, { entryId, command: String(command["type"]), envelope: command,
      action, session, timer, timedOut: false });
    setPendingKeys(new Set([...requests.current.values()].filter((p) => !p.timedOut).map((p) => p.entryId)));
    try {
      socketSend(command);
    } catch {
      finish(requestId, "The action could not be sent. Check the connection and try again.");
    }
  }

  return { sendLifecycle, pendingKeys, dismissedReceipts, actionError: Object.values(errors).join("\n") || null,
    clearActionError: () => setErrors({}) };
}
