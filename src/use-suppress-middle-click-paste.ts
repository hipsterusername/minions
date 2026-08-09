/**
 * Disable the browser's native middle-button behaviours app-wide.
 *
 * On Linux X11/Wayland, middle-click pastes the PRIMARY selection into the
 * editable element under the cursor. On Windows/Linux it also opens the
 * autoscroll cursor. Both interrupt the canvas pan gesture and — worse —
 * trigger paste events into chat inputs and other text fields when a
 * middle-button drag crosses or originates outside the canvas container.
 *
 * Suppression is installed on `document` in the capture phase so it runs
 * before any descendant handler (many of which call `stopPropagation`) and
 * before the browser's default action, regardless of where the click
 * originates. We listen to both `mousedown` (where the PRIMARY paste fires)
 * and `auxclick` (defence in depth for the autoscroll cursor and any
 * browser that defers paste to release).
 */
import { useEffect } from "react";

export function useSuppressMiddleClickPaste(): void {
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    document.addEventListener("mousedown", suppress, true);
    document.addEventListener("auxclick", suppress, true);
    return () => {
      document.removeEventListener("mousedown", suppress, true);
      document.removeEventListener("auxclick", suppress, true);
    };
  }, []);
}
