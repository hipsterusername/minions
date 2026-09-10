import { afterEach, describe, expect, it, vi } from "vitest";
import { startRuntimeMetrics } from "./runtime-metrics.ts";

describe("runtime metrics", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("contains sampling failures and continues until disposed", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const counts = vi.fn()
      .mockImplementationOnce(() => { throw new Error("registry unavailable"); })
      .mockReturnValue({ sessions: 12, activeSessions: 2 });
    stop = startRuntimeMetrics(counts, 1_000);

    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[server:runtime] resource_sample_failed");
    vi.advanceTimersByTime(1_000);
    expect(info).toHaveBeenCalledWith("[server:runtime] resource_sample", expect.objectContaining({
      sessions: 12, activeSessions: 2, heapUsedBytes: expect.any(Number),
      heapLimitBytes: expect.any(Number), rssBytes: expect.any(Number),
      historyCache: expect.objectContaining({ bytes: expect.any(Number), events: expect.any(Number) }),
      artifactValidators: expect.objectContaining({ schemas: expect.any(Number), schemaBytes: expect.any(Number) }),
      outboundQueue: expect.objectContaining({ bytes: expect.any(Number), entries: expect.any(Number) }),
    }));
    stop();
    vi.advanceTimersByTime(10_000);
    expect(counts).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
