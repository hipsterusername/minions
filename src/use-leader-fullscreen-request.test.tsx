import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useLeaderFullscreenRequest } from "./use-leader-fullscreen-request.ts";
import {
  leaderFullscreenStore,
  requestLeaderFullscreen,
  resetLeaderFullscreenRequest,
} from "./leader-fullscreen-request.ts";

afterEach(() => {
  resetLeaderFullscreenRequest();
});

describe("useLeaderFullscreenRequest", () => {
  it("fires onOpen only for a request that names this node", () => {
    const onOpen = vi.fn();
    renderHook(() => useLeaderFullscreenRequest("node-a", onOpen));

    act(() => requestLeaderFullscreen("node-b"));
    expect(onOpen).not.toHaveBeenCalled();

    act(() => requestLeaderFullscreen("node-a"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("consumes the request so it doesn't replay on remount", () => {
    const onOpen = vi.fn();
    const { unmount } = renderHook(() => useLeaderFullscreenRequest("node-a", onOpen));

    act(() => requestLeaderFullscreen("node-a"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The request was cleared on consume.
    expect(leaderFullscreenStore.getSnapshot()).toBeNull();

    unmount();
    const onOpen2 = vi.fn();
    renderHook(() => useLeaderFullscreenRequest("node-a", onOpen2));
    // No pending request → a fresh mount must not auto-open.
    expect(onOpen2).not.toHaveBeenCalled();
  });

  it("re-opens on a fresh request after a previous one was handled", () => {
    const onOpen = vi.fn();
    renderHook(() => useLeaderFullscreenRequest("node-a", onOpen));

    act(() => requestLeaderFullscreen("node-a"));
    act(() => requestLeaderFullscreen("node-a"));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
