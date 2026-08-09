import { describe, expect, it, vi } from "vitest";
import type { WorkItemDetailSnapshot } from "../shared/work-item-contracts.ts";
import type { RuntimeState } from "../shared/work-item-lifecycle.ts";
import { prepareWorkItemArchive } from "./work-item-archive.ts";

function detail(
  runtimeState: RuntimeState,
  lifecycleRevision: number,
  currentRunKey: string | null,
): WorkItemDetailSnapshot {
  return {
    workItem: {
      id: "work-1",
      projectId: "project-1",
      projectPath: "/repo",
      title: "Archive me",
      lifecycle: {
        runtimeState,
        outcome: runtimeState === "inactive" ? "stopped" : "none",
        resolution: "open",
        changeMode: "live",
        integrationState: "live_clean",
        lifecycleRevision,
      },
      waitKind: null,
      currentRunKey,
      iteration: currentRunKey ? 1 : 0,
      lastTransitionAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    bindings: [],
    currentRun: null,
    runs: [],
    nextCursor: null,
  };
}

const input = {
  requestId: "archive-1",
  workItemId: "work-1",
  expectedLifecycleRevision: 1,
  expectedCurrentRunKey: "run-1",
};

describe("prepareWorkItemArchive", () => {
  it.each(["draft", "inactive"] as const)(
    "leaves an already %s item and its caller fence untouched",
    async (runtimeState) => {
      const stopRun = vi.fn();
      const sealStopped = vi.fn();

      const prepared = await prepareWorkItemArchive(input, {
        latest: () => detail(runtimeState, 1, "run-1"),
        stopRun,
        sealStopped,
      });

      expect(prepared).toBe(input);
      expect(stopRun).not.toHaveBeenCalled();
      expect(sealStopped).not.toHaveBeenCalled();
    },
  );

  it("leaves an active item without a canonical run untouched", async () => {
    const stopRun = vi.fn();
    const sealStopped = vi.fn();

    const prepared = await prepareWorkItemArchive(input, {
      latest: () => detail("working", 1, null),
      stopRun,
      sealStopped,
    });

    expect(prepared).toBe(input);
    expect(stopRun).not.toHaveBeenCalled();
    expect(sealStopped).not.toHaveBeenCalled();
  });

  it("uses the post-stop lifecycle fence when termination seals the run", async () => {
    const latest = vi.fn()
      .mockReturnValueOnce(detail("working", 1, "run-1"))
      .mockReturnValueOnce(detail("inactive", 2, "run-1"));
    const stopRun = vi.fn();
    const sealStopped = vi.fn();

    const prepared = await prepareWorkItemArchive(input, {
      latest,
      stopRun,
      sealStopped,
    });

    expect(stopRun).toHaveBeenCalledWith({ workItemId: "work-1", runKey: "run-1" });
    expect(sealStopped).not.toHaveBeenCalled();
    expect(prepared).toEqual({
      ...input,
      expectedLifecycleRevision: 2,
      expectedCurrentRunKey: "run-1",
    });
  });

  it("seals a still-active run when no stop adapter is available", async () => {
    const latest = vi.fn()
      .mockReturnValueOnce(detail("working", 1, "run-1"))
      .mockReturnValueOnce(detail("working", 1, "run-1"));
    const sealed = detail("inactive", 2, "run-1");
    const sealStopped = vi.fn(() => sealed);

    const prepared = await prepareWorkItemArchive(input, {
      latest,
      sealStopped,
    });

    expect(sealStopped).toHaveBeenCalledWith({
      workItemId: "work-1",
      runKey: "run-1",
      expectedLifecycleRevision: 1,
      expectedCurrentRunKey: "run-1",
    });
    expect(prepared).toEqual({
      ...input,
      expectedLifecycleRevision: 2,
      expectedCurrentRunKey: "run-1",
    });
  });
});
