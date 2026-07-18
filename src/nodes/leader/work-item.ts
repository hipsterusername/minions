import type { WorkItemDetailSnapshot, WorkItemSnapshot } from "../../../shared/work-item-contracts.ts";
import { selectWorkItemPresentation } from "../../../shared/work-item-lifecycle.ts";
import { formatCoordinatedLabel, type LiveEditAwareness } from "../../../shared/live-edit-coordination.ts";
import { mergeWorkItemSnapshot } from "../../work-item-snapshot-merge.ts";

export interface CanvasWorkItemFields {
  workItemId?: string | null;
  currentRunKey?: string | null;
  /** Read-only server projection cache; never synthesized from legacy status. */
  workItemSnapshot?: WorkItemSnapshot | null;
}

/**
 * Resolve the immutable change mode from the canonical work item when one is
 * available. The legacy leader flag is only a setup-time fallback for leaders
 * that have not been attached to a canonical work item yet.
 */
export function selectCanvasChangeMode(data: CanvasWorkItemFields & {
  worktreeIsolation: boolean;
}): "live" | "worktree" {
  return data.workItemSnapshot?.lifecycle.changeMode
    ?? (data.worktreeIsolation ? "worktree" : "live");
}

export function detailFromWorkItemResponse(message: unknown): WorkItemDetailSnapshot | null {
  const msg = message as { type?: string; success?: boolean; result?: unknown };
  if (msg.type !== "work_item_response" || !msg.success || !msg.result) return null;
  const detail = msg.result as Partial<WorkItemDetailSnapshot>;
  return detail.workItem?.id ? detail as WorkItemDetailSnapshot : null;
}

export function applyCanvasWorkItemSnapshot<T extends CanvasWorkItemFields>(
  data: T, snapshot: WorkItemSnapshot,
): Omit<T, keyof CanvasWorkItemFields> & { workItemId: string; currentRunKey: string | null; workItemSnapshot: WorkItemSnapshot } {
  if (data.workItemId && data.workItemId !== snapshot.id) return data as Omit<T, keyof CanvasWorkItemFields> & {
    workItemId: string; currentRunKey: string | null; workItemSnapshot: WorkItemSnapshot };
  const merged = data.workItemSnapshot ? mergeWorkItemSnapshot(data.workItemSnapshot, snapshot) : snapshot;
  if (merged === data.workItemSnapshot) return data as Omit<T, keyof CanvasWorkItemFields> & {
    workItemId: string; currentRunKey: string | null; workItemSnapshot: WorkItemSnapshot };
  return { ...data, workItemId: merged.id, currentRunKey: merged.currentRunKey,
    workItemSnapshot: merged } as Omit<T, keyof CanvasWorkItemFields> & { workItemId: string; currentRunKey: string | null;
      workItemSnapshot: WorkItemSnapshot };
}

export function selectCanvasWorkItem(snapshot: WorkItemSnapshot | null | undefined) {
  if (!snapshot) return null;
  const presentation = selectWorkItemPresentation(snapshot.lifecycle,
    { waitKind: snapshot.waitKind });
  const status = snapshot.lifecycle.runtimeState === "starting" ? "creating"
    : snapshot.lifecycle.runtimeState === "working" ? "running"
    : snapshot.lifecycle.outcome === "completed" ? "completed"
    : snapshot.lifecycle.outcome === "error" ? "error"
    : snapshot.lifecycle.outcome === "interrupted" ? "stopped" : "idle";
  const worktreeStatus = snapshot.lifecycle.integrationState === "worktree_integrating"
    || snapshot.lifecycle.integrationState === "worktree_queued" ? "merging"
    : snapshot.lifecycle.integrationState === "worktree_integrated" ? "merged"
    : snapshot.lifecycle.integrationState === "worktree_discarded" ? "discarded"
    : snapshot.lifecycle.integrationState === "worktree_conflicted" ? "failed"
    : snapshot.lifecycle.changeMode === "worktree" && snapshot.lifecycle.runtimeState !== "draft"
      ? "active" : "none";
  return { presentation, status, worktreeStatus } as const;
}

export function canonicalPromptCommand(item: WorkItemSnapshot, prompt: string) {
  const base = { requestId: crypto.randomUUID(), workItemId: item.id,
    expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
    expectedCurrentRunKey: item.currentRunKey, prompt };
  return item.lifecycle.runtimeState === "waiting" && item.waitKind === "decision" && item.currentRunKey
    ? { type: "reply_to_waiting_run" as const, ...base, runKey: item.currentRunKey }
    : { type: "start_work_item_run" as const, ...base };
}

export function selectCanvasPrompt(data: CanvasWorkItemFields & {
  status: "disconnected" | "creating" | "running" | "idle" | "stopped" | "error" | "completed";
  sessionKey: string | null;
}, hasInput: boolean) {
  const canonicalView = selectCanvasWorkItem(data.workItemSnapshot);
  const displayStatus = canonicalView?.status ?? data.status;
  const canonicalTerminal = Boolean(data.workItemSnapshot
    && data.workItemSnapshot.lifecycle.outcome !== "none");
  const blockedCanonicalWait = Boolean(data.workItemSnapshot?.lifecycle.runtimeState === "waiting"
    && data.workItemSnapshot.waitKind !== "decision");
  return { canonicalView, displayStatus,
    placeholder: canonicalTerminal || displayStatus === "completed"
      ? "Describe next goal (context preserved)..."
      : data.sessionKey ? "Guide the leader..." : "Describe your project goal...",
    submitLabel: canonicalTerminal ? "New iteration"
      : displayStatus === "completed" ? "New Session" : data.sessionKey ? "Send" : "Start",
    submitDisabled: blockedCanonicalWait || (!hasInput && Boolean(data.sessionKey) && displayStatus !== "completed"),
    submitActive: !blockedCanonicalWait
      && ((!canonicalTerminal && displayStatus === "completed") || hasInput || !data.sessionKey),
  };
}

export function canvasDetachCommand(data: CanvasWorkItemFields, bindingId: string) {
  const item = data.workItemSnapshot;
  if (!data.workItemId || !item) return null;
  return { type: "detach_work_item_surface", requestId: crypto.randomUUID(),
    workItemId: data.workItemId, surface: "canvas", bindingId,
    expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
    expectedCurrentRunKey: item.currentRunKey };
}

export function formatCanvasWorkItemStatus(snapshot: WorkItemSnapshot | null | undefined,
  awareness: LiveEditAwareness | undefined): string | null {
  const view = selectCanvasWorkItem(snapshot); if (!view) return null;
  return formatCoordinatedLabel(view.presentation.label, awareness);
}
