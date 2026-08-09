/**
 * Factory for spawning MarkdownNodes onto the canvas from a text source
 * (currently: clipboard paste).
 *
 * Lives alongside `image-node-factory.ts` so Canvas.tsx can spawn a
 * text-bearing node with the same shape as the image path: viewport-
 * center anchor, non-overlapping placement, ADD_NODE + select.
 */
import type { CanvasAction, CanvasNode, CanvasTransform } from "../types.ts";
import { generateId } from "../canvas-state.ts";
import { findNonOverlappingPosition, viewportCenter } from "../canvas-utils.ts";

const MARKDOWN_NODE_SIZE = { width: 420, height: 380 };

/** Default title for nodes created from clipboard text. */
export const MARKDOWN_PASTE_TITLE = "Pasted text";

/**
 * Create a MarkdownNode on the canvas from a text block.
 *
 * Picks a non-overlapping position near the given world point (or
 * the viewport center) and dispatches ADD_NODE. Returns false when
 * the text is empty or whitespace-only — callers can use the return
 * value to decide whether to `preventDefault()` the paste.
 */
export function createMarkdownNodeFromText(
  text: string,
  dispatch: (action: CanvasAction) => void,
  setSelectedIds: (ids: Set<string>) => void,
  transform: CanvasTransform,
  existingNodes: ReadonlyArray<CanvasNode>,
  worldPoint?: { x: number; y: number },
): boolean {
  if (text.trim().length === 0) return false;

  const anchor = worldPoint ?? viewportCenter(transform);
  const rawX = anchor.x - MARKDOWN_NODE_SIZE.width / 2;
  const rawY = anchor.y - MARKDOWN_NODE_SIZE.height / 2;
  const position = findNonOverlappingPosition(
    rawX,
    rawY,
    MARKDOWN_NODE_SIZE.width,
    MARKDOWN_NODE_SIZE.height,
    existingNodes as CanvasNode[],
  );

  const node: CanvasNode = {
    id: generateId(),
    type: "markdown",
    position,
    size: { ...MARKDOWN_NODE_SIZE },
    data: { title: MARKDOWN_PASTE_TITLE, content: text, viewMode: "edit" },
  };
  dispatch({ type: "ADD_NODE", node });
  setSelectedIds(new Set([node.id]));
  return true;
}
