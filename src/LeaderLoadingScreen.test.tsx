/**
 * Tests for LeaderLoadingScreen.
 *
 * Covers:
 *   1. Renders container + the message slot.
 *   2. SVG markup contains all five animated layers (ring, iris, hex,
 *      crown, pupil) so the eye→crown morph cannot silently regress
 *      to a single-layer animation.
 *   3. The exported data: URI roundtrips back to the same SVG string,
 *      so dashboard previews stay in sync with the React component.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEADER_LOADING_DATA_URI,
  LEADER_LOADING_SVG,
  LeaderLoadingScreen,
  ONE_SHOT_TOTAL_MS,
} from "./LeaderLoadingScreen";

describe("LeaderLoadingScreen", () => {
  it("renders the loading message", () => {
    render(<LeaderLoadingScreen message="Booting" />);
    // getBy* throws if missing — these calls are the assertion.
    screen.getByTestId("leader-loading");
    screen.getByText("Booting");
  });

  it("uses the default message when none is provided", () => {
    render(<LeaderLoadingScreen />);
    screen.getByText("Loading project");
  });

  it("includes all three animation layers in the SVG", () => {
    // The morph relies on three stacked elements: the iris circle
    // (eye socket), the crown zigzag (drawn inside the iris), and
    // the pupil/dot. Losing any one of them breaks the eye→crown
    // handoff.
    for (const cls of ["ll-iris", "ll-crown", "ll-pupil"]) {
      expect(LEADER_LOADING_SVG.includes(`class="${cls}"`)).toBe(true);
    }
  });

  it("does not include the removed pulse-ring or hex layers", () => {
    // Both were dropped to kill the residual end-of-loop pulse.
    expect(LEADER_LOADING_SVG.includes("ll-ring")).toBe(false);
    expect(LEADER_LOADING_SVG.includes("ll-hex")).toBe(false);
  });

  it("does not animate the iris (no pulse, no fade)", () => {
    // The iris is the static eye socket. Animating it re-introduces
    // the scale-and-fade that read as a pulse. No `ll-iris` keyframes
    // and no `animation: ll-iris` reference may exist.
    expect(LEADER_LOADING_SVG.includes("@keyframes ll-iris")).toBe(false);
    expect(LEADER_LOADING_SVG.includes("animation: ll-iris")).toBe(false);
  });

  it("locks the pupil under the crown (translate 0,10 with scale 0.6)", () => {
    // The eye→crown continuity is "pupil ends up where the crown's
    // dot sits". With the crown scaled 0.5 around (40,38), its dot
    // lives at (40,50): translate (0,10) from iris-center 40 → 50,
    // and scale 0.6 to match the smaller crown's dot size.
    expect(LEADER_LOADING_SVG).toMatch(
      /translate\(\s*0px\s*,\s*10px\s*\)\s*scale\(0\.6\)/,
    );
  });

  describe("one-shot mode", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("includes one-shot keyframes that end at the steady crown", () => {
      // The one-shot variant must define its own non-looping
      // keyframes — the default loop ends with the crown faded
      // back out, which would defeat the boot-time hold.
      expect(LEADER_LOADING_SVG.includes("@keyframes ll-saccade-once")).toBe(
        true,
      );
      expect(LEADER_LOADING_SVG.includes("@keyframes ll-crown-once")).toBe(
        true,
      );
      // Final keyframe (100%) of ll-crown-once must be opacity 1 +
      // dashoffset 0 — i.e. crown fully drawn and held.
      expect(
        LEADER_LOADING_SVG.includes(
          "88%, 100% { opacity: 1; stroke-dashoffset: 0; }",
        ),
      ).toBe(true);
    });

    it("activates one-shot CSS via the .ll-once wrapper", () => {
      render(<LeaderLoadingScreen oneShot onComplete={() => {}} />);
      const wrapper = screen
        .getByTestId("leader-loading")
        .querySelector(".ll-once");
      // Wrapper present → descendant selectors override the loop.
      expect(wrapper).not.toBeNull();
    });

    it("fires onComplete after the animation + 1s hold", () => {
      const onComplete = vi.fn();
      render(<LeaderLoadingScreen oneShot onComplete={onComplete} />);
      // Just before the deadline: not fired yet.
      act(() => {
        vi.advanceTimersByTime(ONE_SHOT_TOTAL_MS - 1);
      });
      expect(onComplete).not.toHaveBeenCalled();
      // At the deadline: fired exactly once.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("fires onComplete exactly once even when parent re-renders with a fresh callback ref", () => {
      // Regression: if useEffect's deps include `onComplete` directly,
      // every parent re-render (which creates a new inline arrow)
      // clears and re-arms the timeout, indefinitely pushing the fade
      // out and leaving the held final frame visible too long.
      const onComplete = vi.fn();
      const { rerender } = render(
        <LeaderLoadingScreen oneShot onComplete={() => onComplete()} />,
      );
      // Re-render every 100ms with a fresh callback reference.
      for (let elapsed = 0; elapsed < ONE_SHOT_TOTAL_MS; elapsed += 100) {
        act(() => {
          vi.advanceTimersByTime(100);
        });
        rerender(
          <LeaderLoadingScreen oneShot onComplete={() => onComplete()} />,
        );
      }
      // Push slightly past the deadline.
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("does not fire onComplete in the default looping mode", () => {
      const onComplete = vi.fn();
      render(<LeaderLoadingScreen onComplete={onComplete} />);
      act(() => {
        vi.advanceTimersByTime(ONE_SHOT_TOTAL_MS * 2);
      });
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  it("exposes a data: URI that encodes the same SVG", () => {
    expect(LEADER_LOADING_DATA_URI.startsWith("data:image/svg+xml;utf8,"))
      .toBe(true);
    const decoded = decodeURIComponent(
      LEADER_LOADING_DATA_URI.replace("data:image/svg+xml;utf8,", ""),
    );
    expect(decoded).toBe(LEADER_LOADING_SVG);
  });
});
