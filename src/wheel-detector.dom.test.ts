/**
 * Unit tests for the wheel-device detector and the pan-gesture flag.
 *
 * The detector classifies wheel events as mouse-vs-trackpad and exposes
 * `isPanGestureActive` so the canvas can keep panning continuously even
 * when the cursor drifts over a `data-scroll-capture` zone mid-gesture.
 *
 * Two important invariants are pinned here:
 *
 *   1. `classify()` must NOT touch the pan-gesture flag. If it did, simply
 *      asking "is this a trackpad event?" while hovering a scroll-capture
 *      zone would mark the canvas as panning, which would defeat the
 *      `device === "trackpad" && !isPanGestureActive` short-circuit in
 *      `Canvas.tsx` and prevent the zone from receiving its scroll.
 *
 *   2. `markPanGestureActive()` must set the flag and auto-clear it after
 *      `GESTURE_TIMEOUT_MS` of silence so the next gesture is evaluated
 *      fresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wheelDetector, wheelZoomFactor } from "./wheel-detector.ts";

// ── Helpers ─────────────────────────────────────────────────────────────

function trackpadEvent(overrides: Partial<WheelEventInit> = {}): WheelEvent {
  // Small fractional pixel-mode delta with a non-zero horizontal component
  // — this is the most reliable trackpad signature in the scoring engine.
  return new WheelEvent("wheel", {
    deltaX: 1.3,
    deltaY: 4.7,
    deltaMode: 0,
    ...overrides,
  });
}

function mouseEvent(overrides: Partial<WheelEventInit> = {}): WheelEvent {
  return new WheelEvent("wheel", {
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
    ...overrides,
  });
}

beforeEach(() => {
  wheelDetector.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  wheelDetector.reset();
});

// ── classify() must not touch pan-gesture state ─────────────────────────

describe("wheelDetector.classify()", () => {
  it("does not set isPanGestureActive when classifying a trackpad event", () => {
    expect(wheelDetector.isPanGestureActive).toBe(false);
    const device = wheelDetector.classify(trackpadEvent());
    expect(device).toBe("trackpad");
    // Critical invariant: classification alone must NOT mark a pan gesture.
    // The canvas decides when it's actually panning.
    expect(wheelDetector.isPanGestureActive).toBe(false);
  });

  it("does not set isPanGestureActive when classifying a mouse event", () => {
    const device = wheelDetector.classify(mouseEvent());
    expect(device).toBe("mouse");
    expect(wheelDetector.isPanGestureActive).toBe(false);
  });

  it("classifies medium vertical-only pixel wheel deltas as mouse", () => {
    const device = wheelDetector.classify(mouseEvent({ deltaY: 40 }));
    expect(device).toBe("mouse");
    expect(wheelDetector.isPanGestureActive).toBe(false);
  });

  it("classifies line and page deltas as mouse wheel input", () => {
    expect(wheelDetector.classify(mouseEvent({ deltaY: 3, deltaMode: 1 }))).toBe(
      "mouse",
    );
    wheelDetector.reset();
    expect(wheelDetector.classify(mouseEvent({ deltaY: 1, deltaMode: 2 }))).toBe(
      "mouse",
    );
  });

  it("treats ambiguous small integer pixel deltas as trackpad input", () => {
    expect(wheelDetector.classify(trackpadEvent({ deltaX: 0, deltaY: 12 }))).toBe(
      "trackpad",
    );
  });

  it("locks the device for the duration of a gesture", () => {
    expect(wheelDetector.classify(trackpadEvent())).toBe("trackpad");
    // A subsequent event that would otherwise look mouse-like should still
    // classify as trackpad while the gesture is in flight.
    expect(wheelDetector.classify(mouseEvent())).toBe("trackpad");
  });
});

describe("wheelZoomFactor()", () => {
  it("makes equal opposite wheel movements reversible", () => {
    const zoomIn = wheelZoomFactor(mouseEvent({ deltaY: -100 }), false);
    const zoomOut = wheelZoomFactor(mouseEvent({ deltaY: 100 }), false);
    expect(zoomIn * zoomOut).toBeCloseTo(1, 12);
  });

  it("normalizes line and pixel wheel deltas to the same notch", () => {
    const pixels = wheelZoomFactor(mouseEvent({ deltaY: 100, deltaMode: 0 }), false);
    const lines = wheelZoomFactor(mouseEvent({ deltaY: 3, deltaMode: 1 }), false);
    expect(lines).toBeCloseTo(pixels, 12);
  });

  it("bounds pinch spikes while preserving direction", () => {
    const zoomIn = wheelZoomFactor(trackpadEvent({ deltaY: -10_000 }), true);
    const zoomOut = wheelZoomFactor(trackpadEvent({ deltaY: 10_000 }), true);
    expect(zoomIn).toBeLessThanOrEqual(1.25);
    expect(zoomOut).toBeGreaterThanOrEqual(0.8);
    expect(zoomIn * zoomOut).toBeCloseTo(1, 12);
  });
});

// ── markPanGestureActive() drives the pan flag ──────────────────────────

describe("wheelDetector.markPanGestureActive()", () => {
  it("flips isPanGestureActive to true", () => {
    expect(wheelDetector.isPanGestureActive).toBe(false);
    wheelDetector.markPanGestureActive();
    expect(wheelDetector.isPanGestureActive).toBe(true);
  });

  it("auto-clears after the gesture timeout", () => {
    wheelDetector.markPanGestureActive();
    expect(wheelDetector.isPanGestureActive).toBe(true);

    // 299ms in — still active.
    vi.advanceTimersByTime(299);
    expect(wheelDetector.isPanGestureActive).toBe(true);

    // 300ms+ — auto-clears.
    vi.advanceTimersByTime(2);
    expect(wheelDetector.isPanGestureActive).toBe(false);
  });

  it("re-arms the timeout on every call so the flag stays true through a gesture", () => {
    wheelDetector.markPanGestureActive();
    vi.advanceTimersByTime(200);
    wheelDetector.markPanGestureActive();
    vi.advanceTimersByTime(200);
    // 400ms total elapsed but we re-armed at 200ms, so we're only 200ms
    // into the latest timeout window.
    expect(wheelDetector.isPanGestureActive).toBe(true);
    vi.advanceTimersByTime(101);
    expect(wheelDetector.isPanGestureActive).toBe(false);
  });
});

// ── End-to-end: scroll-capture-zone behaviour ───────────────────────────

describe("scroll-capture interplay", () => {
  it("first trackpad event over a scroll-capture zone leaves the pan flag false", () => {
    // Simulates the canvas wheel handler: classify the event, then return
    // early without calling markPanGestureActive() because the target is
    // inside a scroll-capture zone.
    const device = wheelDetector.classify(trackpadEvent());
    expect(device).toBe("trackpad");
    expect(wheelDetector.isPanGestureActive).toBe(false);

    // Subsequent events in the same gesture must also see the flag as false
    // so the canvas keeps routing them to the scroll-capture zone.
    wheelDetector.classify(trackpadEvent());
    wheelDetector.classify(trackpadEvent());
    expect(wheelDetector.isPanGestureActive).toBe(false);
  });

  it("once the canvas pans, subsequent events keep the flag true (gesture continuity)", () => {
    // First event: canvas decides to pan and marks the gesture.
    wheelDetector.classify(trackpadEvent());
    wheelDetector.markPanGestureActive();
    expect(wheelDetector.isPanGestureActive).toBe(true);

    // Pointer drifts over a scroll-capture zone mid-gesture. The canvas
    // sees device === "trackpad" && isPanGestureActive === true and falls
    // through to keep panning instead of releasing the gesture.
    wheelDetector.classify(trackpadEvent());
    expect(wheelDetector.isPanGestureActive).toBe(true);
  });
});
