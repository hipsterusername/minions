import type Database from "better-sqlite3";
import type { Bus } from "./bus.ts";
import type { LiveEditCoordinator, LiveEditEvent } from "./live-edit-coordinator.ts";
import { getWorkItem, getWorkItemRun } from "./work-item-repo.ts";
import type { SqliteWorkItemService } from "./work-item-service-sqlite.ts";
import { emitItemChanged } from "./work-item-service-events.ts";
import { liveEditCoordinationEventSchema, liveEditCoordinationEnvelopeSchema,
  type LiveEditCoordinationEvent } from "../shared/live-edit-coordination.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("live-edit-work-item");
type Projection = "clean" | "editing" | "waiting";

function projection(event: LiveEditCoordinationEvent): Projection {
  if (event.type === "queued" || event.type === "baseline_conflict") return "waiting";
  return event.workItemState;
}
function runProjection(event: LiveEditCoordinationEvent): Projection {
  if (event.type === "queued" || event.type === "baseline_conflict") return "waiting";
  return event.runState;
}

export function applyLiveEditWorkItemProjection(db: Database.Database,
  event: LiveEditCoordinationEvent, at = event.at): { changed: boolean; shouldResume: boolean;
    runKind: "primary" | "child" | null } {
  return db.transaction(() => {
    const item = getWorkItem(db, event.workItemId); const run = getWorkItemRun(db, event.runKey);
    const state = projection(event); const runState = runProjection(event);
    if (!item || !run || run.work_item_id !== item.id || item.change_mode !== "live"
      || (run.ended_at !== null && state !== "clean"))
      return { changed: false, shouldResume: false, runKind: null };
    const primary = run.run_kind === "primary"
      && item.current_run_key === run.session_key;
    const desiredIntegration = state === "clean" ? "live_clean"
      : state === "editing" ? "live_editing" : "live_conflict_wait";
    const desiredRuntime = primary && runState === "waiting" && item.runtime_state === "working"
      ? "waiting" : primary && runState !== "waiting" && item.runtime_state === "waiting"
        && item.wait_kind === "file_conflict" ? "working" : item.runtime_state;
    const desiredWait = primary && runState === "waiting" ? "file_conflict"
      : primary && item.wait_kind === "file_conflict" ? null : item.wait_kind;
    if (item.integration_state === desiredIntegration && item.runtime_state === desiredRuntime
      && item.wait_kind === desiredWait) return { changed: false, shouldResume: false,
        runKind: run.run_kind as "primary" | "child" };
    db.prepare(`UPDATE work_items SET integration_state = ?, runtime_state = ?, wait_kind = ?,
      lifecycle_revision = lifecycle_revision + 1, last_transition_at = ?, updated_at = ?
      WHERE id = ? AND lifecycle_revision = ?`).run(desiredIntegration, desiredRuntime,
        desiredWait, at, at, item.id, item.lifecycle_revision);
    return { changed: true, shouldResume: false,
      runKind: run.run_kind as "primary" | "child" };
  }).immediate();
}

export function createLiveEditWorkItemBridge(input: { coordinator: LiveEditCoordinator;
  db: Database.Database; bus: Bus; service: SqliteWorkItemService }) {
  const publish = (event: LiveEditCoordinationEvent) => {
    const item = getWorkItem(input.db, event.workItemId); if (!item) return;
    const payload = { type: "live_edit_coordination", workItemId: event.workItemId,
      event, timestamp: event.at } as const;
    input.bus.emitToWorkItem?.(event.workItemId, payload);
    input.bus.emitToProject(item.project_id, payload);
  };
  const handle = (raw: LiveEditEvent) => {
    const parsed = liveEditCoordinationEventSchema.safeParse(raw);
    if (!parsed.success) { log.warn("invalid_coordinator_event", { issues: parsed.error.issues }); return; }
    const event = parsed.data;
    try {
      const result = applyLiveEditWorkItemProjection(input.db, event);
      if (result.runKind === null) return;
      publish(event);
      if (result.changed) { const detail = input.service.getSync(event.workItemId);
        if (detail) emitItemChanged(input.bus, detail, `live_edit_${projection(event)}`, event.at); }
    } catch (error) { log.warn("projection_failed", { workItemId: event.workItemId,
      runKey: event.runKey, type: event.type, error }); }
  };
  const unsubscribe = input.coordinator.subscribe(handle);
  return { unsubscribe,
    disconnect(runKey: string) { input.coordinator.disconnect(runKey); },
    restart() { input.coordinator.restart(); },
  };
}

export function parseLiveEditEnvelope(value: unknown) {
  return liveEditCoordinationEnvelopeSchema.parse(value);
}
