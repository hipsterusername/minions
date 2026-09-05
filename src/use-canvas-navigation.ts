import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { CanvasNode, CanvasTransform } from "./types.ts";
import { nodeSearchEntry } from "./node-search.ts";

interface ViewSnapshot {
  transform: CanvasTransform;
  selectedIds: string[];
}

interface NavigationOptions {
  historyKey?: string;
  transform: CanvasTransform;
  setTransform: Dispatch<SetStateAction<CanvasTransform>>;
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  nodes: CanvasNode[];
  containerRef: RefObject<HTMLDivElement | null>;
  cancelCameraAnim: () => void;
  clearEdgeSelection: () => void;
}

/** Deliberate jumps have a return path; ordinary pan/zoom never adds history. */
export function useCanvasNavigation(options: NavigationOptions) {
  const latest = useRef(options);
  latest.current = options;
  const history = useRef<ViewSnapshot[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const pendingFocus = useRef<number | null>(null);
  useEffect(() => {
    history.current = [];
    setCanGoBack(false);
    setAnnouncement("");
  }, [options.historyKey]);

  const focusDestination = useCallback((ids: string[]) => {
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
    // Wait for palette/popover cleanup and React's selection update.
    pendingFocus.current = requestAnimationFrame(() => {
      pendingFocus.current = null;
      const container = latest.current.containerRef.current;
      if (!container) return;
      const card = [...container.querySelectorAll<HTMLElement>("[data-canvas-node-id]")]
        .find(element => ids.includes(element.dataset["canvasNodeId"] ?? "") && !element.dataset["parked"]);
      const destination = card ?? container;
      destination.tabIndex = -1;
      destination.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => () => {
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
  }, []);

  const navigateTo = useCallback((target: CanvasTransform, selection?: Set<string>) => {
    const current = latest.current;
    const ids = [...(selection ?? current.selectedIds)];
    const previous = [...current.selectedIds];
    const moved = target.x !== current.transform.x || target.y !== current.transform.y || target.scale !== current.transform.scale;
    const changedSelection = ids.length !== previous.length || ids.some(id => !current.selectedIds.has(id));
    if (moved || changedSelection) {
      history.current = [...history.current.slice(-29), { transform: { ...current.transform }, selectedIds: previous }];
      setCanGoBack(true);
    }
    current.cancelCameraAnim();
    current.clearEdgeSelection();
    current.setSelectedIds(new Set(ids));
    current.setTransform(target);
    latest.current = { ...current, transform: target, selectedIds: new Set(ids) };
    const node = current.nodes.find(candidate => candidate.id === ids[0]);
    setAnnouncement(node ? `Focused: ${nodeSearchEntry(node).title}${ids.length > 1 ? ` and ${ids.length - 1} more` : ""}` : "Canvas overview");
    focusDestination(ids);
  }, [focusDestination]);

  const goBack = useCallback(() => {
    const previous = history.current.pop();
    if (!previous) return;
    const current = latest.current;
    const selectedIds = new Set(previous.selectedIds.filter(id => current.nodes.some(node => node.id === id)));
    current.cancelCameraAnim();
    current.clearEdgeSelection();
    current.setSelectedIds(selectedIds);
    current.setTransform(previous.transform);
    latest.current = { ...current, transform: previous.transform, selectedIds };
    setCanGoBack(history.current.length > 0);
    setAnnouncement("Returned to previous canvas view");
    focusDestination([...selectedIds]);
  }, [focusDestination]);

  return { navigateTo, goBack, canGoBack, announcement };
}
