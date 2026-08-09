import { describe, expect, it } from "vitest";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import { reconcileLegacyCanvasLeaders } from "./canvas-work-item-reconcile.ts";

const item = { id: "work-1", currentRunKey: "run-2" } as WorkItemSnapshot;
const leader = { id: "node-1", type: "leader", position: { x: 0, y: 0 },
  size: { width: 1, height: 1 }, data: { sessionKey: "run-1", status: "idle" } };

describe("legacy Canvas work-item reconciliation", () => {
  it("hydrates from current run identity without synthesizing lifecycle", () => {
    const current = { ...item, currentRunKey: "run-1" };
    const patch = reconcileLegacyCanvasLeaders([leader], [current])[0]!;
    expect(patch.data).toMatchObject({ workItemId: "work-1", currentRunKey: "run-1",
      workItemSnapshot: current });
  });

  it("uses session history identity and follows the item's latest run", () => {
    const patch = reconcileLegacyCanvasLeaders([leader], [item],
      [{ sessionKey: "run-1", workItemId: "work-1" }])[0]!;
    expect(patch.data).toMatchObject({ workItemId: "work-1", currentRunKey: "run-2",
      sessionKey: "run-2", workItemSnapshot: item });
  });

  it("hydrates an already-bound node when its snapshot arrives later", () => {
    const patch = reconcileLegacyCanvasLeaders([{ ...leader, data: {
      ...leader.data, workItemId: "work-1" } }], [item])[0]!;
    expect(patch.data).toMatchObject({ workItemId: "work-1", currentRunKey: "run-2",
      sessionKey: "run-2", workItemSnapshot: item });
  });

  it("leaves unmatched legacy and fully hydrated nodes untouched", () => {
    expect(reconcileLegacyCanvasLeaders([leader], [item])).toEqual([]);
    expect(reconcileLegacyCanvasLeaders([{ ...leader, data: {
      ...leader.data, workItemId: "work-1", workItemSnapshot: item } }], [item])).toEqual([]);
  });
});
