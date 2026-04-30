/**
 * stop_task — asks the SDK to cancel a subagent Task by id.
 */
import { describe, expect, it, vi } from "vitest";
import { stopTask } from "./stop-task.ts";
import { setup, cmd } from "./test-harness.ts";

describe("stop_task", () => {
  it("calls queryHandle.stopTask with the supplied taskId", async () => {
    const h = setup();
    const stop = vi.fn(async () => undefined);
    h.setQueryHandle({ stopTask: stop });

    stopTask(h.ctx, cmd({ type: "stop_task", taskId: "task-42" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledWith("task-42");
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["taskId"]).toBe("task-42");
  });

  it("rejects when taskId is missing", () => {
    const h = setup();
    h.setQueryHandle({ stopTask: vi.fn() });
    stopTask(
      h.ctx,
      cmd({ type: "stop_task", taskId: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("taskId required");
  });

  it("replies with control_error when no queryHandle is attached", () => {
    const h = setup();
    stopTask(
      h.ctx,
      cmd({ type: "stop_task", taskId: "t" }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("propagates the SDK rejection as control_error", async () => {
    const h = setup();
    h.setQueryHandle({
      stopTask: vi.fn(async () => {
        throw new Error("task not found");
      }),
    });
    stopTask(h.ctx, cmd({ type: "stop_task", taskId: "t" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("task not found");
  });
});
