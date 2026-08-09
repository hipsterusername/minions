import path from "node:path";
import fs from "node:fs";
import { createLiveEditCoordinator, type LiveEditCoordinator } from "./live-edit-coordinator.ts";
import type { LiveEditAwareness } from "../shared/live-edit-coordination.ts";

const coordinators = new Map<string, LiveEditCoordinator>();
const listeners = new Set<(projectPath: string, coordinator: LiveEditCoordinator) => void>();

export function getLiveEditCoordinator(projectPath: string): LiveEditCoordinator {
  const key = fs.realpathSync(path.resolve(projectPath));
  let coordinator = coordinators.get(key);
  if (!coordinator) {
    coordinator = createLiveEditCoordinator({ projectPath: key });
    coordinators.set(key, coordinator);
    for (const listener of listeners) listener(key, coordinator);
  }
  return coordinator;
}

export function subscribeLiveEditCoordinators(
  listener: (projectPath: string, coordinator: LiveEditCoordinator) => void,
): () => void {
  listeners.add(listener);
  for (const [projectPath, coordinator] of coordinators) listener(projectPath, coordinator);
  return () => listeners.delete(listener);
}

export function resetLiveEditCoordinators(): void {
  for (const coordinator of coordinators.values()) coordinator.restart();
  coordinators.clear();
}

export function snapshotLiveEditAwareness(projectPath: string,
  workItemIds: readonly string[], at = Date.now()): Record<string, LiveEditAwareness> {
  const coordinator = getLiveEditCoordinator(projectPath);
  return Object.fromEntries(workItemIds.flatMap((workItemId) => {
    const snapshot = coordinator.snapshotWorkItem(workItemId);
    if (snapshot.state === "clean") return [];
    const queued = snapshot.queued[0];
    const paths = [...new Set([
      ...snapshot.active.flatMap((entry) => entry.paths.map((path) => path.path)),
      ...snapshot.queued.flatMap((entry) => entry.paths),
    ])];
    return [[workItemId, { runState: snapshot.state, paths,
      queuePosition: queued?.queuePosition ?? null,
      blockingRunKeys: queued ? [...queued.blockingRunKeys] : [],
      baselineConflict: snapshot.baselineConflict,
      updatedAt: at } satisfies LiveEditAwareness] as const];
  }));
}
