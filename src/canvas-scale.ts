/**
 * Module-level mutable ref holding the current canvas zoom scale.
 *
 * Updated by `Canvas` on every render (before children).  Read by
 * `CanvasNode` and `ResizeHandle` inside event handlers (drag, resize)
 * where they need to convert screen-pixels → canvas-coords.
 *
 * Why not a prop?  Passing `canvasScale: number` as a React prop busts
 * `React.memo` on **every** node whenever the user zooms — even though
 * nodes don't need to visually re-render (the parent container's CSS
 * `transform: scale()` handles the visual zoom).  Using a module-level
 * ref keeps the value fresh for interaction math without triggering any
 * React re-renders.
 *
 * Safe for single-canvas apps (which this is).  If multiple canvases
 * are ever needed, promote to a React context + ref pattern.
 */
export const canvasScale = { current: 1 };
