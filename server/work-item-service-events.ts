import type { Bus } from "./bus.ts";
import type { WorkItemBindingSnapshot, WorkItemDetailSnapshot, WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";
import { workItemBindingChangedEnvelopeSchema, workItemRunCreatedEnvelopeSchema, workItemRunSealedEnvelopeSchema } from "../shared/ws-envelope.ts";

export function emitItemChanged(bus: Bus, detail: WorkItemDetailSnapshot, cause: string, at: number): void {
  const payload = { type: "work_item_changed", workItem: detail.workItem,
    revision: detail.workItem.lifecycle.lifecycleRevision, cause, timestamp: at };
  bus.emitToWorkItem?.(detail.workItem.id, payload);
  bus.emitToProject(detail.workItem.projectId, payload);
}

export function emitRunChanged(bus: Bus, type: "work_item_run_created" | "work_item_run_sealed", detail: WorkItemDetailSnapshot, run: WorkItemRunSnapshot, at: number): void {
  const schema = type === "work_item_run_created" ? workItemRunCreatedEnvelopeSchema : workItemRunSealedEnvelopeSchema;
  for (const topic of [`work-item:${detail.workItem.id}`, `project:${detail.workItem.projectId}`]) {
    bus.emit(schema.parse({ topic, type, workItemId: detail.workItem.id, run, timestamp: at }));
  }
}

export function emitBindingChanged(bus: Bus, detail: WorkItemDetailSnapshot, binding: WorkItemBindingSnapshot, at: number): void {
  for (const topic of [`work-item:${detail.workItem.id}`, `project:${detail.workItem.projectId}`]) {
    bus.emit(workItemBindingChangedEnvelopeSchema.parse({ topic, type: "work_item_binding_changed",
      workItemId: detail.workItem.id, binding, timestamp: at }));
  }
}
