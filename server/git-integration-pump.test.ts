import { describe, expect, it, vi } from "vitest";
import { createGitIntegrationPump } from "./git-integration-pump.ts";

describe("Git integration scope pump", () => {
  it("stops draining on a dirty-target wait and retries only after backoff", async () => {
    const runNext = vi.fn()
      .mockResolvedValueOnce({ status: "waiting", error: "dirty main" })
      .mockResolvedValueOnce(null);
    let retry: (() => void) | undefined;
    const pump = createGitIntegrationPump({ runNext }, {
      retryDelayMs: 10, setTimer: ((callback: () => void) => {
        retry = callback; return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      }) as never,
    });
    pump.notify("/repo", "refs/heads/main");
    await vi.waitFor(() => expect(runNext).toHaveBeenCalledTimes(1));
    await Promise.resolve(); expect(runNext).toHaveBeenCalledTimes(1);
    retry?.();
    await vi.waitFor(() => expect(runNext).toHaveBeenCalledTimes(2));
    pump.shutdown();
  });

  it("continues FIFO after terminal work but coalesces duplicate notifications", async () => {
    let resolve!: (value: unknown) => void;
    const runNext = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValueOnce(null);
    const pump = createGitIntegrationPump({ runNext });
    pump.notify("/repo", "lineage"); pump.notify("/repo", "lineage");
    expect(runNext).toHaveBeenCalledOnce();
    resolve({ status: "succeeded", targetSha: "x", resultSha: "x", sourceSha: "x",
      headReachable: true, cleaned: true, recovered: false, targetMoved: false });
    await vi.waitFor(() => expect(runNext).toHaveBeenCalledTimes(2));
    pump.shutdown();
  });
});
