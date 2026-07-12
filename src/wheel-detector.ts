/**
 * Classifies a wheel gesture as a stepped mouse wheel or a trackpad gesture.
 *
 * Browsers do not expose the source device, so this deliberately uses only
 * signals available on the first event. The result is held for the gesture;
 * changing modes after movement has begun feels much worse than an imperfect
 * first-event heuristic.
 */

export type WheelDevice = "mouse" | "trackpad";

const GESTURE_TIMEOUT_MS = 300;
const MOUSE_DELTA_QUANTUM = 100;
const SMALL_DELTA_THRESHOLD = 10;
const MEDIUM_MOUSE_DELTA_THRESHOLD = 20;

/**
 * Turn a wheel delta into a bounded, resolution-independent zoom factor.
 * Exponential scaling makes opposite deltas exact inverses of one another.
 */
export function wheelZoomFactor(e: WheelEvent, isPinch: boolean): number {
  if (isPinch) {
    const delta = Math.max(-24, Math.min(24, e.deltaY));
    return Math.exp(-delta * 0.009);
  }

  const rawNotches =
    e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? e.deltaY / 3
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? e.deltaY
        : e.deltaY / 100;
  const notches = Math.max(-1, Math.min(1, rawNotches));
  return Math.exp(-notches * 0.08);
}

class WheelDeviceDetector {
  private lastEventTime = 0;
  private lockedDevice: WheelDevice | null = null;
  private _isPanGestureActive = false;
  private panGestureTimer: ReturnType<typeof setTimeout> | null = null;

  get isPanGestureActive(): boolean {
    return this._isPanGestureActive;
  }

  /** Keep canvas panning continuous if the pointer crosses a scrollable node. */
  markPanGestureActive(): void {
    this._isPanGestureActive = true;
    if (this.panGestureTimer !== null) clearTimeout(this.panGestureTimer);
    this.panGestureTimer = setTimeout(() => {
      this._isPanGestureActive = false;
      this.panGestureTimer = null;
    }, GESTURE_TIMEOUT_MS);
  }

  classify(e: WheelEvent): WheelDevice {
    const now = e.timeStamp || performance.now();
    if (now - this.lastEventTime > GESTURE_TIMEOUT_MS) {
      this.lockedDevice = null;
    }
    this.lastEventTime = now;

    if (this.lockedDevice !== null) return this.lockedDevice;
    this.lockedDevice = this.classifyGestureStart(e);
    return this.lockedDevice;
  }

  private classifyGestureStart(e: WheelEvent): WheelDevice {
    // Firefox and some drivers report stepped wheels in lines/pages. A
    // trackpad uses pixel deltas, so non-pixel modes are conclusive.
    if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return "mouse";

    const x = Math.abs(e.deltaX);
    const y = Math.abs(e.deltaY);
    let mouseScore = x <= 0.5 ? 1 : 0;
    let trackpadScore = x > 0.5 ? 3 : 0;

    if (y > 0 && y < SMALL_DELTA_THRESHOLD) {
      trackpadScore += 3;
    } else if (y >= MOUSE_DELTA_QUANTUM && y % MOUSE_DELTA_QUANTUM === 0) {
      mouseScore += 3;
    } else if (
      x <= 0.5 &&
      Number.isInteger(y) &&
      y >= MEDIUM_MOUSE_DELTA_THRESHOLD
    ) {
      // Chromium can normalize a physical notch to values below 100px.
      mouseScore += 2;
    } else if (!Number.isInteger(y)) {
      trackpadScore += 2;
    } else if (y >= 50) {
      mouseScore += 1;
    }

    // Ambiguous pixel events pan. An unwanted pan is easier to recover from
    // than a sudden zoom, especially for integer-valued trackpad drivers.
    return mouseScore > trackpadScore + 1 ? "mouse" : "trackpad";
  }

  reset(): void {
    this.lastEventTime = 0;
    this.lockedDevice = null;
    this._isPanGestureActive = false;
    if (this.panGestureTimer !== null) {
      clearTimeout(this.panGestureTimer);
      this.panGestureTimer = null;
    }
  }
}

export const wheelDetector = new WheelDeviceDetector();
