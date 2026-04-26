/**
 * Factory for spawning ImageNodes onto the canvas from a File source
 * (clipboard paste, drag-drop, or a file-picker pick).
 *
 * Lives outside the component file so Canvas.tsx / use-canvas-file-drop.ts
 * can call it without pulling the render tree into their bundle, and so
 * `src/nodes/ImageNode.tsx` stays under its Phase 3 size target.
 */
import type { CanvasAction, CanvasNode, CanvasTransform } from "../types.ts";
import { generateId } from "../canvas-state.ts";
import { findNonOverlappingPosition, viewportCenter } from "../canvas-utils.ts";
import { createImageNodeDefaultData, type ImageNodeData } from "./ImageNode.tsx";
import { loadImageFromFile } from "./image-loader.ts";

const IMAGE_NODE_SIZE = { width: 480, height: 420 };

/**
 * Create an ImageNode on the canvas from a File.
 *
 * Reads the file as a data URL, probes natural dimensions in the
 * background, picks a non-overlapping position near the given world
 * point (or the viewport center), and dispatches ADD_NODE.
 */
export async function createImageNodeFromFile(
  file: File,
  dispatch: (action: CanvasAction) => void,
  setSelectedIds: (ids: Set<string>) => void,
  transform: CanvasTransform,
  existingNodes: ReadonlyArray<CanvasNode>,
  worldPoint?: { x: number; y: number },
): Promise<void> {
  if (!file.type.startsWith("image/")) return;

  let loaded;
  try {
    loaded = await loadImageFromFile(file);
  } catch {
    // Decode failed — nothing sensible to render, skip the node entirely
    // rather than spawning an empty slot the user has to clean up.
    return;
  }

  const anchor = worldPoint ?? viewportCenter(transform);
  const rawX = anchor.x - IMAGE_NODE_SIZE.width / 2;
  const rawY = anchor.y - IMAGE_NODE_SIZE.height / 2;
  const position = findNonOverlappingPosition(
    rawX,
    rawY,
    IMAGE_NODE_SIZE.width,
    IMAGE_NODE_SIZE.height,
    existingNodes as CanvasNode[],
  );

  const data: ImageNodeData = {
    ...createImageNodeDefaultData(),
    src: loaded.src,
    filename: loaded.filename,
    naturalWidth: loaded.naturalWidth,
    naturalHeight: loaded.naturalHeight,
  };

  const node: CanvasNode = {
    id: generateId(),
    type: "image",
    position,
    size: { ...IMAGE_NODE_SIZE },
    data,
  };
  dispatch({ type: "ADD_NODE", node });
  setSelectedIds(new Set([node.id]));
}
