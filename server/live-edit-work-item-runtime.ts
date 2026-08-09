import type Database from "better-sqlite3";
import type { Bus } from "./bus.ts";
import { subscribeLiveEditCoordinators } from "./live-edit-runtime.ts";
import { createLiveEditWorkItemBridge } from "./live-edit-work-item-bridge.ts";
import type { SqliteWorkItemService } from "./work-item-service-sqlite.ts";

export function installLiveEditWorkItemBridges(input: { db: Database.Database;
  bus: Bus; service: SqliteWorkItemService }) {
  const bridges = new Map<string, ReturnType<typeof createLiveEditWorkItemBridge>>();
  const unsubscribeRegistry = subscribeLiveEditCoordinators((projectPath, coordinator) => {
    bridges.get(projectPath)?.unsubscribe();
    bridges.set(projectPath, createLiveEditWorkItemBridge({ ...input, coordinator }));
  });
  return {
    disconnectRun(runKey: string) { for (const bridge of bridges.values()) bridge.disconnect(runKey); },
    shutdown() { unsubscribeRegistry(); for (const bridge of bridges.values()) {
      bridge.restart(); bridge.unsubscribe();
    } bridges.clear(); },
    get size() { return bridges.size; },
  };
}
