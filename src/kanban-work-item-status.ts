import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import { formatCoordinatedLabel, type LiveEditAwareness } from "../shared/live-edit-coordination.ts";
import { selectCanvasWorkItem } from "./nodes/leader/work-item.ts";

export function projectKanbanWorkItemStatus(item: WorkItemSnapshot,
  awareness: LiveEditAwareness | undefined, metrics?: { cost: number; turns: number }) {
  const view = selectCanvasWorkItem(item);
  return { status: view?.status ?? "disconnected",
    worktreeStatus: view?.worktreeStatus ?? "none", cost: metrics?.cost ?? 0,
    turns: metrics?.turns ?? 0,
    ...(view ? { presentationLabel: formatCoordinatedLabel(view.presentation.label, awareness),
      presentationBadge: view.presentation.badge } : {}) };
}
