/**
 * Custom hook for canvas keyboard shortcuts:
 * - Space: toggle pan mode
 * - Delete/Backspace: delete selected nodes (with leader cascade + group confirmation)
 * - Ctrl/Cmd+Z: undo
 * - Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y: redo
 */
import { useEffect, type Dispatch, type MutableRefObject } from "react";
import type { CanvasNode, CanvasAction } from "./types.ts";
import type { GraphDocument } from "./graph.ts";
import type { GraphAction } from "./graph-runtime.ts";
import type { RenderNodeData } from "./nodes/RenderNode.tsx";

/** Helper: returns true if the event target is a text input element. */
function isTextInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

export interface UseCanvasKeyboardOpts {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  nodes: CanvasNode[];
  graph: GraphDocument;
  dispatch: Dispatch<CanvasAction>;
  graphDispatch: Dispatch<GraphAction>;
  /** Ref to the space-bar pressed state, shared with pan handling */
  spaceRef: MutableRefObject<boolean>;
  /** Function to test if a node is inside a context group */
  isInsideGroup: (node: CanvasNode, group: CanvasNode) => boolean;
  /** Show a confirmation dialog before deleting context groups with children */
  setPendingGroupDelete: (info: {
    groupIds: string[];
    containedIds: string[];
    otherIds: string[];
  } | null) => void;
  /** Focus (center + zoom) on a set of nodes */
  focusNodes?: (ids: Set<string>) => void;
  undo?: () => void;
  redo?: () => void;
}

export function useCanvasKeyboard({
  selectedIds,
  setSelectedIds,
  nodes,
  graph,
  dispatch,
  graphDispatch,
  spaceRef,
  isInsideGroup,
  setPendingGroupDelete,
  focusNodes,
  undo,
  redo,
}: UseCanvasKeyboardOpts): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ── Space: pan mode ──
      if (e.code === "Space" && !e.repeat) {
        if (isTextInput(e.target)) return;
        e.preventDefault();
        spaceRef.current = true;
      }

      // ── Delete / Backspace: delete selected nodes ──
      if (e.code === "Delete" || e.code === "Backspace") {
        if (isTextInput(e.target)) return;

        // Expand deletion: when a leader is deleted, also delete its
        // connected minions + render node
        const toDelete = new Set(selectedIds);
        for (const id of selectedIds) {
          const node = nodes.find((n) => n.id === id);
          if (node?.type === "leader") {
            for (const edge of graph.edges) {
              if (edge.sourceNodeId === id && edge.sourcePortId === "task-out") {
                toDelete.add(edge.targetNodeId);
              }
            }
            // Also delete affixed render nodes
            for (const n of nodes) {
              if (n.type === "render" && (n.data as RenderNodeData).leaderId === id) {
                toDelete.add(n.id);
              }
            }
          }
        }

        // Check if any selected nodes are context-groups with contained nodes
        const groupIds: string[] = [];
        const containedIds = new Set<string>();
        for (const id of toDelete) {
          const node = nodes.find((n) => n.id === id);
          if (node?.type === "context-group") {
            const inside = nodes.filter(
              (n) => n.id !== id && n.type !== "context-group" && !toDelete.has(n.id) && isInsideGroup(n, node),
            );
            if (inside.length > 0) {
              groupIds.push(id);
              for (const n of inside) containedIds.add(n.id);
            }
          }
        }

        if (groupIds.length > 0) {
          // Show confirmation modal instead of deleting immediately
          const otherIds = [...toDelete].filter((id) => !groupIds.includes(id));
          setPendingGroupDelete({ groupIds, containedIds: [...containedIds], otherIds });
          return;
        }

        for (const id of toDelete) {
          dispatch({ type: "REMOVE_NODE", id });
          graphDispatch({ type: "REMOVE_EDGES_FOR_NODE", nodeId: id });
        }
        setSelectedIds(new Set());
      }

      // ── F: Focus selected node(s) ──
      if (e.code === "KeyF" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (isTextInput(e.target)) return;
        if (selectedIds.size > 0 && focusNodes) {
          e.preventDefault();
          focusNodes(selectedIds);
        }
      }

      // ── Undo/Redo ──
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey) {
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        undo?.();
      }
      if (
        (mod && e.key === "z" && e.shiftKey) ||
        (mod && e.key === "y")
      ) {
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        redo?.();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [selectedIds, nodes, graph, dispatch, graphDispatch, spaceRef, isInsideGroup, setPendingGroupDelete, focusNodes, undo, redo]);
}
