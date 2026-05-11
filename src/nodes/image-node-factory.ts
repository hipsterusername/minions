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
import { loadImageFromFile, type LoadedImage } from "./image-loader.ts";
import { loadImageFromProjectPath } from "./image-loader-from-path.ts";

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

/**
 * Spawn an ImageNode from a project-relative file path.
 *
 * Reuses the same downscale/decode pipeline as the File-based factory by
 * routing through {@link loadImageFromProjectPath}. Used by the
 * project-tree click handler and tree-drag drop so opening an image
 * surfaces it as a real image (with annotation support) instead of a
 * binary text dump in a FileViewerNode.
 *
 * Returns `true` on success, `false` if the load failed — callers can
 * fall back to a FileViewerNode rather than leaving the user with no
 * affordance at all.
 */
export async function createImageNodeFromProjectPath(
  projectPath: string,
  relativePath: string,
  dispatch: (action: CanvasAction) => void,
  setSelectedIds: (ids: Set<string>) => void,
  transform: CanvasTransform,
  existingNodes: ReadonlyArray<CanvasNode>,
  worldPoint?: { x: number; y: number },
): Promise<boolean> {
  let loaded: LoadedImage;
  try {
    loaded = await loadImageFromProjectPath(projectPath, relativePath);
  } catch {
    return false;
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
  return true;
}
