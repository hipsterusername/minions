/**
 * Disable browser-level page zoom gestures inside the app.
 *
 * Trackpad pinch-to-zoom is delivered as a wheel event with ctrlKey/metaKey
 * in Chromium/WebKit. Canvas.tsx consumes those events when the pointer is
 * over the canvas, but the app chrome sits outside that listener. Capturing
 * the event globally prevents the browser from zooming the whole UI while
 * still letting the event bubble to the canvas when appropriate.
 */
import { useEffect } from "react";

export function isBrowserZoomWheelEvent(e: WheelEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

export function usePreventBrowserZoom(): void {
  useEffect(() => {
    const preventBrowserZoom = (e: WheelEvent) => {
      if (isBrowserZoomWheelEvent(e)) e.preventDefault();
    };

    document.addEventListener("wheel", preventBrowserZoom, {
      capture: true,
      passive: false,
    });
    return () => {
      document.removeEventListener("wheel", preventBrowserZoom, true);
    };
  }, []);
}
