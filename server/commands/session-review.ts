import {
  acknowledgeReview,
  commitReviewLifecycle,
  dismissReview,
  reopenReview,
} from "../session-review-lifecycle.ts";
import { getSessionOrError, sendControlError, sendControlResponse } from "./helpers.ts";
import { WorkItemServiceError } from "../work-item-service.ts";
import type { CommandHandler } from "./types.ts";
import type { WorkItemDetailSnapshot } from "../../shared/work-item-contracts.ts";
import type { SessionHost } from "../session-host.ts";
import type { Bus } from "../bus.ts";
import crypto from "node:crypto";

function syncBoundHost(
  host: SessionHost,
  detail: WorkItemDetailSnapshot,
  action: "acknowledge" | "dismiss" | "reopen",
  bus: Bus,
): void {
  const current = host.reviewLifecycle;
  const at = detail.workItem.updatedAt;
  const next = {
    ...current,
    acknowledgedAt: action === "acknowledge" ? at : current.acknowledgedAt,
    dismissedAt: action === "dismiss" ? at : action === "reopen" ? null : current.dismissedAt,
    lifecycleRevision: detail.workItem.lifecycle.lifecycleRevision,
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  host.reviewLifecycle = next;
  const event = { type: "session_lifecycle_changed" as const, sessionKey: host.id,
    lifecycle: next, timestamp: at };
  host.bufferEvent(event);
  bus.emitToSession(host.id, event);
}

async function handleBound(
  ctx: Parameters<CommandHandler>[0], cmd: Parameters<CommandHandler>[1],
  ws: Parameters<CommandHandler>[2], action: "acknowledge" | "dismiss" | "reopen",
): Promise<void> {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  const command = `${action}_session`;
  if (!ctx.workItems || !host.workItemId) {
    sendControlError(ws, command, host.id, cmd.requestId, "Canonical work-item service is unavailable", {
      code: "unavailable",
    });
    return;
  }
  try {
    // Acknowledge and dismiss are monotonic (same policy as the unbound path
    // below): applying them to a newer snapshot is safe, and the canonical
    // mutation is CAS-fenced with the freshly read work-item revision anyway.
    // The host clock mixes session and work-item counters across restarts, so
    // hard-fencing user clicks against it rejects perfectly valid requests
    // (e.g. after boot recovery seals interrupted runs). Reopen reverses user
    // intent and therefore retains strict compare-and-set ordering.
    if (action === "reopen"
      && cmd.expectedLifecycleRevision !== host.reviewLifecycle.lifecycleRevision) {
      sendControlError(ws, command, host.id, cmd.requestId, "Lifecycle revision conflict", {
        code: "LIFECYCLE_REVISION_CONFLICT", lifecycle: host.reviewLifecycle,
      });
      return;
    }
    const before = await ctx.workItems.get(host.workItemId);
    if (!before) throw new WorkItemServiceError("not_found", "work item not found");
    const input = { requestId: crypto.randomUUID(), workItemId: host.workItemId,
      expectedLifecycleRevision: before.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: before.workItem.currentRunKey };
    const detail = action === "acknowledge"
      ? await ctx.workItems.review(input)
      : action === "dismiss"
        ? await ctx.workItems.archive(input)
        : await ctx.workItems.restore(input);
    syncBoundHost(host, detail, action, ctx.bus);
    sendControlResponse(ws, command, host.id, cmd.requestId, {
      lifecycle: host.reviewLifecycle, workItem: detail.workItem,
    });
  } catch (error) {
    const typed = error instanceof WorkItemServiceError ? error : null;
    sendControlError(ws, command, host.id, cmd.requestId,
      typed?.message ?? (error instanceof Error ? error.message : "Work-item review mutation failed"), {
        code: typed?.code ?? "internal", latest: typed?.latest ?? null,
      });
  }
}

function handler(action: "acknowledge" | "dismiss" | "reopen"): CommandHandler {
  return (ctx, cmd, ws) => {
    const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
    if (!host) return;
    if (host.workItemId) {
      void handleBound(ctx, cmd, ws, action);
      return;
    }
    const command = `${action}_session`;
    const current = host.reviewLifecycle;
    const alreadyApplied =
      (action === "acknowledge" && current.acknowledgedAt !== null) ||
      (action === "dismiss" && current.dismissedAt !== null) ||
      (action === "reopen" && current.dismissedAt === null);
    // Acknowledge and dismiss are monotonic timestamps, so applying them to a
    // newer snapshot is safe and avoids UI no-ops when a dashboard mutation
    // advances the revision between render and click. Reopen reverses user
    // intent and therefore retains strict compare-and-set ordering.
    if (
      action === "reopen" &&
      !alreadyApplied &&
      cmd.expectedLifecycleRevision !== current.lifecycleRevision
    ) {
      sendControlError(ws, command, host.id, cmd.requestId, "Lifecycle revision conflict", {
        code: "LIFECYCLE_REVISION_CONFLICT",
        lifecycle: current,
      });
      return;
    }
    const now = Date.now();
    const next = alreadyApplied
      ? current
      : action === "acknowledge"
        ? acknowledgeReview(current, now)
        : action === "dismiss"
          ? dismissReview(current, now)
          : reopenReview(current);
    commitReviewLifecycle(host, ctx.bus, next, now);
    sendControlResponse(ws, command, host.id, cmd.requestId, { lifecycle: host.reviewLifecycle });
  };
}

export const acknowledgeSession = handler("acknowledge");
export const dismissSession = handler("dismiss");
export const reopenSession = handler("reopen");
