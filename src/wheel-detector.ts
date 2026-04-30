/**
 * wheel-detector.ts
 *
 * Lightweight heuristic engine to classify WheelEvents as originating from
 * a **mouse scroll wheel** or a **trackpad two-finger gesture**.
 *
 * ## Why this is needed
 *
 * The Web doesn't expose a direct "device type" for wheel events. Both mice
 * and trackpads fire the same `WheelEvent`, but their characteristics differ:
 *
 * | Signal            | Mouse wheel                  | Trackpad                      |
 * |-------------------|------------------------------|-------------------------------|
 * | deltaMode         | 1 (line) in Firefox          | 0 (pixel) everywhere          |
 * | deltaY magnitude  | Large discrete (~100-120px)  | Small, often fractional       |
 * | deltaX            | Almost always 0              | Often non-zero                |
 * | Frequency         | Low (~50-200ms between ticks)| High (~8-16ms, 60+ fps)       |
 * | Inertia/momentum  | None — stops instantly       | Decays gradually after lift   |
 *
 * ## Strategy
 *
 * We maintain a small sliding window of recent events and use a **scoring
 * system** that weighs multiple signals. The classification sticks once
 * confident and resets after a quiet period (no events for 300ms), so a
 * gesture that starts on a trackpad stays classified as trackpad even if
 * individual events happen to look mouse-like.
 *
 * ## Usage
 *
 *   import { wheelDetector } from "./wheel-detector";
 *
 *   element.addEventListener("wheel", (e) => {
 *     const device = wheelDetector.classify(e);
 *     // device === "mouse" | "trackpad"
 *   });
 */

export type WheelDevice = "mouse" | "trackpad";

interface WheelSample {
  timestamp: number;
  absDeltaY: number;
  absDeltaX: number;
  deltaMode: number;
}

// ── Tuning constants ──────────────────────────────────────────────────

/** After this much silence we reset the classification for the next gesture. */
const GESTURE_TIMEOUT_MS = 300;

/** How many recent samples to keep for frequency analysis. */
const WINDOW_SIZE = 6;

/**
 * Mouse wheels in Chrome/Edge produce deltaY that's a multiple of this.
 * (Firefox uses deltaMode=1 with integer line counts instead.)
 */
const MOUSE_DELTA_QUANTUM = 100;

/**
 * If the median inter-event interval is below this, it's almost certainly
 * a trackpad (mice rarely exceed ~20 events/sec even with fast scrolling).
 */
const TRACKPAD_INTERVAL_THRESHOLD_MS = 30;

/**
 * Absolute deltaY below this is a strong trackpad signal — mouse wheels
 * almost never produce sub-pixel deltas.
 */
const SMALL_DELTA_THRESHOLD = 10;

// ── Detector state ────────────────────────────────────────────────────

class WheelDeviceDetector {
  private samples: WheelSample[] = [];
  private lastEventTime = 0;

  /**
   * Locked classification for the current gesture. Once we're confident,
   * we stick with it until the gesture ends (timeout).
   */
  private lockedDevice: WheelDevice | null = null;

  /**
   * Whether the canvas is currently being panned via wheel events. Set
   * explicitly by the canvas through `markPanGestureActive()` whenever it
   * actually consumes a wheel event as a pan, and auto-clears after the
   * gesture timeout (no further pan events).
   *
   * The detector itself does NOT touch this flag — classification and pan
   * tracking are separate concerns. If they were coupled, simply asking
   * "is this a trackpad event?" while hovering a scroll-capture zone would
   * mark the canvas as panning, which would then prevent subsequent events
   * in the same gesture from scrolling the zone.
   */
  private _isPanGestureActive = false;
  private panGestureTimer: ReturnType<typeof setTimeout> | null = null;

  /** True while the canvas is actively consuming wheel events as a pan. */
  get isPanGestureActive(): boolean {
    return this._isPanGestureActive;
  }

  /**
   * The canvas calls this every time it actually pans in response to a
   * wheel event. The flag stays true until `GESTURE_TIMEOUT_MS` of silence,
   * at which point it auto-resets so the next wheel gesture is evaluated
   * fresh.
   */
  markPanGestureActive(): void {
    this._isPanGestureActive = true;
    if (this.panGestureTimer !== null) {
      clearTimeout(this.panGestureTimer);
    }
    this.panGestureTimer = setTimeout(() => {
      this._isPanGestureActive = false;
      this.panGestureTimer = null;
    }, GESTURE_TIMEOUT_MS);
  }

  /**
   * Classify a WheelEvent as mouse or trackpad.
   *
   * For pinch events (ctrlKey === true), we don't classify — the caller
   * should handle those separately as zoom regardless of device.
   */
  classify(e: WheelEvent): WheelDevice {
    const now = e.timeStamp || performance.now();

    // ── Reset if this is the start of a new gesture ───────────────
    if (now - this.lastEventTime > GESTURE_TIMEOUT_MS) {
      this.samples = [];
      this.lockedDevice = null;
    }

    this.lastEventTime = now;

    // ── Collect sample ────────────────────────────────────────────
    const sample: WheelSample = {
      timestamp: now,
      absDeltaY: Math.abs(e.deltaY),
      absDeltaX: Math.abs(e.deltaX),
      deltaMode: e.deltaMode,
    };

    this.samples.push(sample);
    if (this.samples.length > WINDOW_SIZE) {
      this.samples.shift();
    }

    // ── Return locked classification if we have one ───────────────
    if (this.lockedDevice !== null) {
      return this.lockedDevice;
    }

    // ── Classify ──────────────────────────────────────────────────
    const device = this.score(e, sample);

    // Lock after first classification so the gesture stays consistent.
    this.lockedDevice = device;
    return device;
  }

  private score(e: WheelEvent, current: WheelSample): WheelDevice {
    // Firefox mouse wheel: deltaMode === 1 (line-based) is conclusive.
    if (e.deltaMode === 1) {
      return "mouse";
    }

    let mouseScore = 0;
    let trackpadScore = 0;

    // ── Signal 1: Horizontal component ────────────────────────────
    // Mouse scroll wheels almost never produce deltaX.
    if (current.absDeltaX > 0.5) {
      trackpadScore += 3;
    } else {
      mouseScore += 1;
    }

    // ── Signal 2: Delta magnitude ─────────────────────────────────
    // Mouse wheels produce large, quantised deltas.
    if (current.absDeltaY > 0) {
      if (current.absDeltaY < SMALL_DELTA_THRESHOLD) {
        // Very small delta — strong trackpad signal
        trackpadScore += 3;
      } else if (
        current.absDeltaY % MOUSE_DELTA_QUANTUM === 0 &&
        current.absDeltaY >= MOUSE_DELTA_QUANTUM
      ) {
        // Exact multiple of 100 — strong mouse signal
        mouseScore += 3;
      } else if (current.absDeltaY % 1 !== 0) {
        // Fractional delta — trackpad
        trackpadScore += 2;
      } else if (current.absDeltaY >= 50) {
        // Large integer but not a clean multiple — slight mouse lean
        mouseScore += 1;
      }
    }

    // ── Signal 3: Event frequency ─────────────────────────────────
    // Trackpads fire at display refresh rate (8-16ms intervals).
    // Mouse wheels fire much slower (50-200ms+).
    if (this.samples.length >= 3) {
      const intervals: number[] = [];
      for (let i = 1; i < this.samples.length; i++) {
        intervals.push(this.samples[i]!.timestamp - this.samples[i - 1]!.timestamp);
      }
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)]!;

      if (median < TRACKPAD_INTERVAL_THRESHOLD_MS) {
        trackpadScore += 3;
      } else if (median > 80) {
        mouseScore += 2;
      }
    }

    // ── Signal 4: Consistency of deltas ───────────────────────────
    // Mouse wheels produce very consistent deltaY across events.
    // Trackpads produce variable deltas (acceleration, deceleration).
    if (this.samples.length >= 3) {
      const deltas = this.samples.map((s) => s.absDeltaY).filter((d) => d > 0);
      if (deltas.length >= 2) {
        const allSame = deltas.every((d) => d === deltas[0]!);
        if (allSame && deltas[0]! >= MOUSE_DELTA_QUANTUM) {
          mouseScore += 2;
        }

        // High variance relative to mean → trackpad
        const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        if (mean > 0) {
          const variance =
            deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / deltas.length;
          const cv = Math.sqrt(variance) / mean; // coefficient of variation
          if (cv > 0.5) {
            trackpadScore += 1;
          }
        }
      }
    }

    // ── Decision ──────────────────────────────────────────────────
    // On a tie or near-tie, default to trackpad (pan) since accidentally
    // panning when you meant to zoom is less disruptive than accidentally
    // zooming when you meant to pan.
    return mouseScore > trackpadScore + 1 ? "mouse" : "trackpad";
  }

  /** Force-reset all state. Useful for testing or cleanup. */
  reset(): void {
    this.samples = [];
    this.lastEventTime = 0;
    this.lockedDevice = null;
    this._isPanGestureActive = false;
    if (this.panGestureTimer !== null) {
      clearTimeout(this.panGestureTimer);
      this.panGestureTimer = null;
    }
  }
}

/** Singleton instance — safe because wheel events are single-threaded. */
export const wheelDetector = new WheelDeviceDetector();
