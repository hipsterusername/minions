import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearLeaderFullscreen,
  leaderFullscreenStore,
  requestLeaderFullscreen,
  resetLeaderFullscreenRequest,
} from "./leader-fullscreen-request.ts";

afterEach(() => {
  resetLeaderFullscreenRequest();
});

describe("leader-fullscreen-request", () => {
  it("starts with no pending request", () => {
    expect(leaderFullscreenStore.getSnapshot()).toBeNull();
  });

  it("records the requested node id and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = leaderFullscreenStore.subscribe(listener);

    requestLeaderFullscreen("node-1");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(leaderFullscreenStore.getSnapshot()).toMatchObject({ nodeId: "node-1" });
    unsubscribe();
  });

  it("increments the nonce so repeated requests for the same node are distinguishable", () => {
    requestLeaderFullscreen("node-1");
    const first = leaderFullscreenStore.getSnapshot()!.nonce;
    requestLeaderFullscreen("node-1");
    const second = leaderFullscreenStore.getSnapshot()!.nonce;
    expect(second).toBeGreaterThan(first);
  });

  it("clears a consumed request and notifies once", () => {
    requestLeaderFullscreen("node-1");
    const listener = vi.fn();
    leaderFullscreenStore.subscribe(listener);

    clearLeaderFullscreen();
    expect(leaderFullscreenStore.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    // Clearing again is a no-op (nothing to notify about).
    clearLeaderFullscreen();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = leaderFullscreenStore.subscribe(listener);
    unsubscribe();
    requestLeaderFullscreen("node-2");
    expect(listener).not.toHaveBeenCalled();
  });
});
