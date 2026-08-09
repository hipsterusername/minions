import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";

export function reconcileLegacyCanvasLeaders(
  nodes: readonly CanvasNode[], items: readonly WorkItemSnapshot[],
  sessions: readonly { sessionKey: string; workItemId?: string | null }[] = [],
): Array<{ nodeId: string; data: LeaderData }> {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const itemByRun = new Map(items.flatMap((item) => item.currentRunKey
    ? [[item.currentRunKey, item] as const] : []));
  const workIdByRun = new Map(sessions.flatMap((session) => session.workItemId
    ? [[session.sessionKey, session.workItemId] as const] : []));
  return nodes.flatMap((node) => {
    if (node.type !== "leader") return [];
    const data = node.data as LeaderData;
    if (data.workItemId) {
      const bound = itemById.get(data.workItemId);
      if (!bound || data.workItemSnapshot === bound) return [];
      return [{ nodeId: node.id, data: { ...data, currentRunKey: bound.currentRunKey,
        workItemSnapshot: bound, sessionKey: bound.currentRunKey ?? data.sessionKey } }];
    }
    if (!data.sessionKey) return [];
    const item = itemByRun.get(data.sessionKey)
      ?? itemById.get(workIdByRun.get(data.sessionKey) ?? "");
    if (!item) return [];
    return [{ nodeId: node.id, data: { ...data, workItemId: item.id,
      currentRunKey: item.currentRunKey, workItemSnapshot: item,
      sessionKey: item.currentRunKey ?? data.sessionKey } }];
  });
}
