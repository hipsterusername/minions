import { createRef } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LEADER_DEFAULT_DATA, type LeaderData } from "./types.ts";
import { useLaunchFeedback } from "./use-launch-feedback.ts";

describe("launch feedback", () => {
  it("locks synchronously through latency, announces only server state and focuses without scrolling", () => {
    const target = createRef<HTMLDivElement>();
    target.current = document.createElement("div");
    const focus = vi.spyOn(target.current, "focus");
    const started = vi.fn();
    const { result, rerender } = renderHook(({ data }) => useLaunchFeedback(data, target, started),
      { initialProps: { data: { ...LEADER_DEFAULT_DATA } } });
    act(() => {
      expect(result.current.begin("exact prompt")).toBe(true);
      expect(result.current.begin("duplicate")).toBe(false);
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.notice).toBeNull();
    rerender({ data: { ...LEADER_DEFAULT_DATA, sessionKey: "leader-1", status: "creating" } });
    expect(started).not.toHaveBeenCalled();
    rerender({ data: { ...LEADER_DEFAULT_DATA, sessionKey: "leader-1", status: "running" } });
    expect(result.current.notice).toBe("Leader started");
    expect(started).toHaveBeenCalledExactlyOnceWith("exact prompt");
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    rerender({ data: { ...LEADER_DEFAULT_DATA, sessionKey: "leader-1", status: "idle" } });
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("unlocks explicit rejection but keeps uncertain launches locked", () => {
    const target = createRef<HTMLElement>();
    const failed = vi.fn();
    const data: LeaderData = { ...LEADER_DEFAULT_DATA, model: "sonnet", skillIds: ["review"] };
    const { result, rerender } = renderHook(({ value }) => useLaunchFeedback(value, target, undefined, failed),
      { initialProps: { value: data } });
    act(() => { result.current.begin("keep prompt"); });
    rerender({ value: { ...data, status: "error", error: "Unavailable" } });
    expect(result.current.pending).toBe(false);
    expect(failed).toHaveBeenCalledOnce();
    rerender({ value: data });
    act(() => { expect(result.current.begin("keep prompt")).toBe(true); });
    act(() => result.current.failed(true));
    expect(result.current.notice).toContain("Launch not confirmed");
    act(() => { expect(result.current.begin("duplicate")).toBe(false); });
    expect(data.model).toBe("sonnet");
  });
});
