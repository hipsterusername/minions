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

const IMAGE_NODE_SIZE = { width: 480, height: 420 };

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = src;
  });
}

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

  const src = await readFileAsDataURL(file);
  let dims = { width: 0, height: 0 };
  try {
    dims = await loadImageDimensions(src);
  } catch {
    // Non-fatal — the node still shows the image without a dimension badge.
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
    src,
    filename: file.name && file.name !== "" ? file.name : "Pasted image",
  };
  if (dims.width > 0) data.naturalWidth = dims.width;
  if (dims.height > 0) data.naturalHeight = dims.height;

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
