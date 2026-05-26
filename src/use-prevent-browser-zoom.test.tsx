/**
 * Behaviour tests for `usePreventBrowserZoom`.
 *
 * The hook must catch pinch-style wheel events anywhere in the app, including
 * chrome that sits outside the canvas container. It only prevents the browser
 * default; it does not stop propagation, so canvas-local handlers can still
 * implement canvas zoom.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { usePreventBrowserZoom } from "./use-prevent-browser-zoom.ts";

function Probe() {
  usePreventBrowserZoom();
  return null;
}

describe("usePreventBrowserZoom", () => {
  it("preventDefaults ctrl-wheel anywhere in the document", () => {
    const { unmount } = render(<Probe />);

    const event = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: 12,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    unmount();
  });

  it("preventDefaults meta-wheel anywhere in the document", () => {
    const { unmount } = render(<Probe />);

    const event = new WheelEvent("wheel", {
      metaKey: true,
      deltaY: 12,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    unmount();
  });

  it("does not interfere with ordinary wheel scrolling", () => {
    const { unmount } = render(<Probe />);

    const event = new WheelEvent("wheel", {
      deltaY: 12,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);

    unmount();
  });

  it("does not stop propagation to canvas-local wheel handlers", () => {
    const { unmount } = render(<Probe />);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const handler = vi.fn();
    container.addEventListener("wheel", handler);

    const event = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: 12,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(handler).toHaveBeenCalledOnce();

    container.remove();
    unmount();
  });

  it("removes its listener on unmount", () => {
    const { unmount } = render(<Probe />);
    unmount();

    const event = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: 12,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
