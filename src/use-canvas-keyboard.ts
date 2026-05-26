/**
 * Custom hook for canvas keyboard shortcuts:
 * - Space: toggle pan mode
 * - Delete/Backspace: delete selected nodes (with leader cascade + group confirmation)
 * - Ctrl/Cmd+C: copy selected Leader setup
 * - Ctrl/Cmd+Shift+V: paste copied Leader setup as a new Leader
 * - Ctrl/Cmd+Z: undo
 * - Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y: redo
 * - N: focus next active (running) node
 * - L: create Leader at the cursor when the cursor is over empty canvas
 * - Ctrl/Cmd+K: open command palette
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
  /** Currently selected edge ID, if any. When set, Delete removes that edge
   *  instead of touching nodes. */
  selectedEdgeId?: string | null;
  /** Called when Delete/Backspace is pressed and only an edge is selected. */
  onDeleteSelectedEdge?: (() => void) | undefined;
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
  focusNodes?: ((ids: Set<string>) => void) | undefined;
  /** Cycle focus to the next active (running) node */
  focusNextActive?: (() => void) | undefined;
  copyLeaderSetup?: ((nodeId: string) => boolean) | undefined;
  pasteLeaderSetup?: (() => boolean) | undefined;
  createLeaderAtCursor?: (() => boolean) | undefined;
  openCommandPalette?: (() => void) | undefined;
  undo?: (() => void) | undefined;
  redo?: (() => void) | undefined;
}

export function useCanvasKeyboard({
  selectedIds,
  setSelectedIds,
  selectedEdgeId,
  onDeleteSelectedEdge,
  nodes,
  graph,
  dispatch,
  graphDispatch,
  spaceRef,
  isInsideGroup,
  setPendingGroupDelete,
  focusNodes,
  focusNextActive,
  copyLeaderSetup,
  pasteLeaderSetup,
  createLeaderAtCursor,
  openCommandPalette,
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

      // ── Delete / Backspace: delete selected edge OR nodes ──
      if (e.code === "Delete" || e.code === "Backspace") {
        if (isTextInput(e.target)) return;

        // Edge selection takes priority: if an edge is selected and no
        // node is, remove just the edge. Node + edge selections are
        // mutually exclusive by construction (see Canvas.tsx), so the
        // `selectedIds.size === 0` guard is defensive — it preserves the
        // node-delete path if both ever coexist.
        if (selectedEdgeId && selectedIds.size === 0) {
          onDeleteSelectedEdge?.();
          return;
        }

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

      // ── N: Focus next active (running) node ──
      if (e.code === "KeyN" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (isTextInput(e.target)) return;
        if (focusNextActive) {
          e.preventDefault();
          focusNextActive();
        }
      }

      // ── Copy/Paste Leader setup ──
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if (isTextInput(e.target)) return;
        e.preventDefault();
        openCommandPalette?.();
        return;
      }

      if (
        e.code === "KeyL" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.repeat
      ) {
        if (isTextInput(e.target)) return;
        if (createLeaderAtCursor?.()) {
          e.preventDefault();
          return;
        }
      }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c") {
        if (isTextInput(e.target)) return;
        if (selectedIds.size === 1 && copyLeaderSetup) {
          const id = [...selectedIds][0];
          if (id && copyLeaderSetup(id)) {
            e.preventDefault();
          }
        }
      }
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "v") {
        if (isTextInput(e.target)) return;
        if (pasteLeaderSetup?.()) {
          e.preventDefault();
        }
      }

      // ── Undo/Redo ──
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
  }, [selectedIds, selectedEdgeId, onDeleteSelectedEdge, nodes, graph, dispatch, graphDispatch, spaceRef, isInsideGroup, setPendingGroupDelete, focusNodes, focusNextActive, copyLeaderSetup, pasteLeaderSetup, createLeaderAtCursor, openCommandPalette, undo, redo]);
}
