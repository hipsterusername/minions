import { describe, expect, it } from "vitest";
import { liveEditCoordinationEnvelopeSchema, reduceLiveEditAwareness } from "../../shared/live-edit-coordination.ts";

const queued = { type: "queued" as const, requestId: "request-1", workItemId: "work-1",
  runKey: "run-1", runState: "waiting" as const, workItemState: "waiting" as const,
  paths: ["src/a.ts"], queuePosition: 2,
  blockingRunKeys: ["run-2"], at: 10 };

describe("live-edit coordination contract", () => {
  it("validates work-item topic identity and structured FIFO context", () => {
    expect(liveEditCoordinationEnvelopeSchema.parse({ topic: "work-item:work-1",
      type: "live_edit_coordination", workItemId: "work-1", event: queued,
      timestamp: 10 }).event).toEqual(queued);
    expect(() => liveEditCoordinationEnvelopeSchema.parse({ topic: "work-item:other",
      type: "live_edit_coordination", workItemId: "work-1", event: queued,
      timestamp: 10 })).toThrow(/identity mismatch/);
  });

  it("retains queue awareness until FIFO grant and clears it on cleanup", () => {
    const waiting = reduceLiveEditAwareness(undefined, queued);
    expect(waiting).toMatchObject({ runState: "waiting", paths: ["src/a.ts"],
      queuePosition: 2, blockingRunKeys: ["run-2"] });
    const editing = reduceLiveEditAwareness(waiting, { type: "granted", requestId: "request-1",
      token: "token-1", workItemId: "work-1", runKey: "run-1", runState: "editing",
      workItemState: "editing",
      paths: ["src/a.ts"], acquiredAt: 10, at: 11, expiresAt: 20, maxHoldAt: 30 });
    expect(editing).toMatchObject({ runState: "editing", queuePosition: null,
      blockingRunKeys: [] });
    expect(reduceLiveEditAwareness(editing, { type: "released", token: "token-1",
      workItemId: "work-1", runKey: "run-1", runState: "clean", paths: ["src/a.ts"],
      workItemState: "clean",
      reason: "terminal", at: 12 })).toMatchObject({ runState: "clean", paths: [] });
  });

  it("does not let a delayed queue event regress a later clean release", () => {
    const clean = reduceLiveEditAwareness(undefined, { type: "released", token: "token",
      workItemId: "work-1", runKey: "run-1", runState: "clean", workItemState: "clean",
      paths: ["src/a.ts"], at: 20 });
    expect(reduceLiveEditAwareness(clean, queued)).toBe(clean);
  });

  it("clears baseline conflict awareness after a refreshed editing heartbeat", () => {
    const conflict = reduceLiveEditAwareness(undefined, { type: "baseline_conflict", token: "t",
      workItemId: "work-1", runKey: "run-1", runState: "waiting", workItemState: "waiting",
      paths: ["a.ts"], at: 1 });
    const refreshed = reduceLiveEditAwareness(conflict, { type: "heartbeat", token: "t",
      workItemId: "work-1", runKey: "run-1", runState: "editing", workItemState: "editing",
      paths: ["a.ts"], expiresAt: 20, at: 2 });
    expect(refreshed).toMatchObject({ baselineConflict: false, runState: "editing" });
  });

  it("uses aggregate item paths when multiple runs edit disjoint files", () => {
    const first = reduceLiveEditAwareness(undefined, { type: "granted", requestId: "a", token: "a",
      workItemId: "work", runKey: "run-a", runState: "editing", workItemState: "editing",
      paths: ["a.ts"], workItemPaths: ["a.ts"], acquiredAt: 1, at: 1, expiresAt: 10, maxHoldAt: 20 });
    const second = reduceLiveEditAwareness(first, { type: "granted", requestId: "b", token: "b",
      workItemId: "work", runKey: "run-b", runState: "editing", workItemState: "editing",
      paths: ["b.ts"], workItemPaths: ["a.ts", "b.ts"], acquiredAt: 2, at: 2, expiresAt: 11, maxHoldAt: 21 });
    expect(second.paths).toEqual(["a.ts", "b.ts"]);
    const remaining = reduceLiveEditAwareness(second, { type: "released", token: "a",
      workItemId: "work", runKey: "run-a", runState: "clean", workItemState: "editing",
      paths: ["a.ts"], workItemPaths: ["b.ts"], at: 3 });
    expect(remaining).toMatchObject({ runState: "editing", paths: ["b.ts"] });
  });
});
