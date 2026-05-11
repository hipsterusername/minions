/**
 * Behaviour test for `useSuppressMiddleClickPaste`.
 *
 * The hook exists to stop the browser's native middle-button behaviours
 * (Linux PRIMARY-selection paste, autoscroll). The bug it fixes manifested
 * when a middle-click started outside the canvas container — the previous
 * container-scoped listener never ran, so a paste fired on the input under
 * the cursor. The test mounts the hook and dispatches a `mousedown` on a
 * detached element nowhere near the canvas to confirm `preventDefault` is
 * still called.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useSuppressMiddleClickPaste } from "./use-suppress-middle-click-paste.ts";

function Probe() {
  useSuppressMiddleClickPaste();
  return null;
}

describe("useSuppressMiddleClickPaste", () => {
  it("preventDefaults a middle-button mousedown anywhere in the document", () => {
    const { unmount } = render(<Probe />);

    // Dispatch on `document.body` to prove the listener is global, not
    // scoped to the canvas container.
    const event = new MouseEvent("mousedown", {
      button: 1,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    unmount();
  });

  it("preventDefaults a middle-button auxclick anywhere in the document", () => {
    const { unmount } = render(<Probe />);

    const event = new MouseEvent("auxclick", {
      button: 1,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    unmount();
  });

  it("does not interfere with left-button mousedown", () => {
    const { unmount } = render(<Probe />);

    const event = new MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);

    unmount();
  });

  it("removes its listeners on unmount", () => {
    const { unmount } = render(<Probe />);
    unmount();

    const event = new MouseEvent("mousedown", {
      button: 1,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
