/**
 * Custom hook encapsulating all file-drop handling for the canvas:
 * - DragOver / DragEnter / DragLeave events with counter-based tracking
 * - Drop handling for project-tree files, project-tree folders, and OS files
 * - File upload to the project API
 */
import { useState, useCallback, useRef, type Dispatch, type MutableRefObject } from "react";
import type { CanvasNode, CanvasAction, CanvasTransform } from "./types.ts";
import { generateId } from "./canvas-state.ts";
import { getAllNodeTypes } from "./node-registry.ts";
import { findNonOverlappingPosition } from "./canvas-utils.ts";
import {
  createImageNodeFromFile,
  createImageNodeFromProjectPath,
} from "./nodes/image-node-factory.ts";
import { isImagePath } from "./nodes/image-loader-from-path.ts";
import { getAuthToken } from "./api.ts";

/** Default expanded height for folder nodes created via drag-drop. */
const DEFAULT_EXPANDED_HEIGHT_FOLDER = 360;

export interface UseCanvasFileDropOpts {
  dispatch: Dispatch<CanvasAction>;
  setSelectedIds: (ids: Set<string>) => void;
  /** Ref to the container element */
  containerRef: MutableRefObject<HTMLDivElement | null>;
  /** Ref to the current canvas transform */
  transformRef: MutableRefObject<CanvasTransform>;
  /** Ref to the current nodes array */
  nodesRef: MutableRefObject<CanvasNode[]>;
  projectPath?: string | undefined;
}

export interface UseCanvasFileDropResult {
  isDragOverCanvas: boolean;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragEnter: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleFileDrop: (e: React.DragEvent) => Promise<void>;
}

export function useCanvasFileDrop({
  dispatch,
  setSelectedIds,
  containerRef,
  transformRef,
  nodesRef,
  projectPath,
}: UseCanvasFileDropOpts): UseCanvasFileDropResult {
  const [isDragOverCanvas, setIsDragOverCanvas] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const hasFiles = e.dataTransfer.types.includes("Files");
    const hasTreePath = e.dataTransfer.types.includes("application/x-tree-path");
    if (!hasFiles && !hasTreePath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = hasTreePath ? "move" : "copy";
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    const hasFiles = e.dataTransfer.types.includes("Files");
    const hasTreePath = e.dataTransfer.types.includes("application/x-tree-path");
    if (!hasFiles && !hasTreePath) return;
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsDragOverCanvas(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const hasFiles = e.dataTransfer.types.includes("Files");
    const hasTreePath = e.dataTransfer.types.includes("application/x-tree-path");
    if (!hasFiles && !hasTreePath) return;
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOverCanvas(false);
    }
  }, []);

  const handleFileDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOverCanvas(false);

      // ── Handle project-tree file drops ──
      const treePath = e.dataTransfer.getData("application/x-tree-path");
      const treeType = e.dataTransfer.getData("application/x-tree-type");
      if (treePath && treeType === "dir") {
        const t = transformRef.current;
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const dropX = (e.clientX - rect.left - t.x) / t.scale;
        const dropY = (e.clientY - rect.top - t.y) / t.scale;

        const allTypes = getAllNodeTypes();
        const folderType = allTypes.find((td) => td.type === "folder");
        if (!folderType) return;

        const rawX = dropX - folderType.defaultSize.width / 2;
        const rawY = dropY - folderType.defaultSize.height / 2;
        const position = findNonOverlappingPosition(
          rawX,
          rawY,
          folderType.defaultSize.width,
          folderType.defaultSize.height,
          nodesRef.current,
        );

        const node: CanvasNode = {
          id: generateId(),
          type: "folder",
          position,
          size: { width: folderType.defaultSize.width, height: DEFAULT_EXPANDED_HEIGHT_FOLDER },
          data: { folderPath: treePath, collapsed: false, expandedHeight: DEFAULT_EXPANDED_HEIGHT_FOLDER },
        };
        dispatch({ type: "ADD_NODE", node });
        setSelectedIds(new Set([node.id]));
        return;
      }

      if (treePath && treeType === "file") {
        const t = transformRef.current;
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const dropX = (e.clientX - rect.left - t.x) / t.scale;
        const dropY = (e.clientY - rect.top - t.y) / t.scale;

        // Images take the ImageNode path so a dropped .png renders as an
        // image and not as a binary text dump.
        if (isImagePath(treePath) && projectPath) {
          const ok = await createImageNodeFromProjectPath(
            projectPath,
            treePath,
            dispatch,
            setSelectedIds,
            t,
            nodesRef.current,
            { x: dropX, y: dropY },
          );
          if (ok) return;
          // Fall through to FileViewer on failure rather than leaving
          // the user with no node at all.
        }

        const allTypes = getAllNodeTypes();
        const fileViewerType = allTypes.find((td) => td.type === "file-viewer");
        if (!fileViewerType) return;

        const rawX = dropX - fileViewerType.defaultSize.width / 2;
        const rawY = dropY - fileViewerType.defaultSize.height / 2;
        const position = findNonOverlappingPosition(
          rawX,
          rawY,
          fileViewerType.defaultSize.width,
          fileViewerType.defaultSize.height,
          nodesRef.current,
        );

        const node: CanvasNode = {
          id: generateId(),
          type: "file-viewer",
          position,
          size: { width: fileViewerType.defaultSize.width, height: 420 },
          data: { filePath: treePath, collapsed: false, expandedHeight: 420 },
        };
        dispatch({ type: "ADD_NODE", node });
        setSelectedIds(new Set([node.id]));
        return;
      }

      // ── Handle OS file drops ──
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      const t = transformRef.current;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();

      // World-space position of the drop
      const dropX = (e.clientX - rect.left - t.x) / t.scale;
      const dropY = (e.clientY - rect.top - t.y) / t.scale;

      const allTypes = getAllNodeTypes();
      const fileViewerType = allTypes.find((t) => t.type === "file-viewer");
      if (!fileViewerType) return;

      // Image files → ImageNode (visual-context plan, Phase 3).
      // Handled separately so we don't attempt to upload binary
      // images as text via the file-upload route.
      const imageFiles = files.filter((f) => f?.type.startsWith("image/"));
      if (imageFiles.length > 0) {
        for (let i = 0; i < imageFiles.length; i++) {
          const file = imageFiles[i];
          if (!file) continue;
          await createImageNodeFromFile(
            file,
            dispatch,
            setSelectedIds,
            t,
            nodesRef.current,
            { x: dropX, y: dropY + i * 60 },
          );
        }
        const nonImages = files.filter((f) => !f?.type.startsWith("image/"));
        if (nonImages.length === 0) return;
      }

      // Upload each non-image file and create nodes
      const remaining = files.filter((f) => !f?.type.startsWith("image/"));
      for (let i = 0; i < remaining.length; i++) {
        const file = remaining[i];
        if (!file) continue;

        // Position each subsequent file-viewer below the previous one
        const rawX = dropX - fileViewerType.defaultSize.width / 2;
        const rawY = dropY + i * 50 - fileViewerType.defaultSize.height / 2;
        const position = findNonOverlappingPosition(
          rawX,
          rawY,
          fileViewerType.defaultSize.width,
          fileViewerType.defaultSize.height,
          nodesRef.current,
        );

        // Upload to project if we have a project path
        if (projectPath) {
          try {
            const reader = new FileReader();
            const base64 = await new Promise<string>((resolve, reject) => {
              reader.onload = () => {
                const result = reader.result as string;
                // Strip the data:...;base64, prefix
                const b64 = result.split(",")[1] ?? "";
                resolve(b64);
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });

            const token = await getAuthToken();
            const resp = await fetch("/api/files/upload", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                projectPath,
                filePath: file.name,
                contentBase64: base64,
              }),
            });
            const json = (await resp.json()) as { ok?: boolean; relativePath?: string; error?: string };

            if (json.ok && json.relativePath) {
              const node: CanvasNode = {
                id: generateId(),
                type: "file-viewer",
                position,
                size: { ...fileViewerType.defaultSize },
                data: { filePath: json.relativePath, collapsed: false },
              };
              dispatch({ type: "ADD_NODE", node });
              setSelectedIds(new Set([node.id]));
            }
          } catch {
            // If upload fails, still create a note about it
            const noteType = allTypes.find((t) => t.type === "note");
            if (noteType) {
              const node: CanvasNode = {
                id: generateId(),
                type: "note",
                position,
                size: { ...noteType.defaultSize },
                data: { text: `Failed to upload: ${file.name}` },
              };
              dispatch({ type: "ADD_NODE", node });
            }
          }
        } else {
          // No project path — just create a note with file info
          const noteType = allTypes.find((t) => t.type === "note");
          if (noteType) {
            const node: CanvasNode = {
              id: generateId(),
              type: "note",
              position,
              size: { ...noteType.defaultSize },
              data: { text: `Dropped file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)\nNo project open to save to.` },
            };
            dispatch({ type: "ADD_NODE", node });
          }
        }
      }
    },
    [dispatch, setSelectedIds, containerRef, transformRef, nodesRef, projectPath],
  );

  return {
    isDragOverCanvas,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleFileDrop,
  };
}
