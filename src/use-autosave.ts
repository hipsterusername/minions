import { useRef, useEffect, useState, useCallback } from "react";
import type { CanvasNode, CanvasTransform } from "./types.ts";
import type { GraphDocument } from "./graph.ts";
import { saveProjectState } from "./api.ts";

export type SaveStatus = "saved" | "saving" | "unsaved" | "error" | "idle";

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;
const SESSION_NODE_TYPES = new Set(["leader", "minion", "claude-session"]);
const TRANSIENT_SESSION_FIELDS = ["streamingText", "streamingBlockIndex"] as const;

interface AutosaveResult {
  status: SaveStatus;
  lastSaved: Date | null;
  forceSave: () => void;
  retryCount: number;
  retry: () => void;
}

export function toPersistableNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => {
    if (!SESSION_NODE_TYPES.has(node.type) || !isRecord(node.data)) {
      return node;
    }

    let changed = false;
    const data = { ...node.data };
    for (const key of TRANSIENT_SESSION_FIELDS) {
      if (key in data) {
        delete data[key];
        changed = true;
      }
    }

    return changed ? { ...node, data } : node;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionNodeType(type: string): boolean {
  return SESSION_NODE_TYPES.has(type);
}

function isTransientSessionField(key: string): boolean {
  return (TRANSIENT_SESSION_FIELDS as readonly string[]).includes(key);
}

function persistableDataEqual(
  type: string,
  a: unknown,
  b: unknown,
): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b)) return Object.is(a, b);

  const ignoreTransient = isSessionNodeType(type);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (ignoreTransient && isTransientSessionField(key)) continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function persistableNodeEqual(a: CanvasNode, b: CanvasNode): boolean {
  return (
    a === b ||
    (
      a.id === b.id &&
      a.type === b.type &&
      a.position.x === b.position.x &&
      a.position.y === b.position.y &&
      a.size.width === b.size.width &&
      a.size.height === b.size.height &&
      persistableDataEqual(a.type, a.data, b.data)
    )
  );
}

function persistableNodesEqual(a: CanvasNode[], b: CanvasNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || !persistableNodeEqual(left, right)) return false;
  }
  return true;
}

function graphEqual(a: GraphDocument, b: GraphDocument): boolean {
  if (a === b) return true;
  if (a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.edges.length; i += 1) {
    const left = a.edges[i];
    const right = b.edges[i];
    if (
      !left ||
      !right ||
      left.id !== right.id ||
      left.sourceNodeId !== right.sourceNodeId ||
      left.sourcePortId !== right.sourcePortId ||
      left.targetNodeId !== right.targetNodeId ||
      left.targetPortId !== right.targetPortId ||
      left.protocol !== right.protocol
    ) {
      return false;
    }
  }
  return true;
}

function transformEqual(a: CanvasTransform, b: CanvasTransform): boolean {
  return a === b || (a.x === b.x && a.y === b.y && a.scale === b.scale);
}

export function useAutosave(
  projectId: string | null,
  nodes: CanvasNode[],
  graph: GraphDocument,
  transform: CanvasTransform,
  delayMs = 1500,
): AutosaveResult {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nodesRef = useRef(nodes);
  const graphRef = useRef(graph);
  const transformRef = useRef(transform);
  const projectIdRef = useRef(projectId);
  const initialLoadRef = useRef(true);
  const retryCountRef = useRef(0);
  const lastObservedRef = useRef<{
    nodes: CanvasNode[];
    graph: GraphDocument;
    transform: CanvasTransform;
  } | null>(null);

  nodesRef.current = nodes;
  graphRef.current = graph;
  transformRef.current = transform;
  projectIdRef.current = projectId;

  const clearRetryTimer = useCallback(() => {
    clearTimeout(retryTimerRef.current);
  }, []);

  const doSave = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid) return;

    setStatus("saving");
    try {
      await saveProjectState(pid, {
        transform: transformRef.current,
        nodes: toPersistableNodes(nodesRef.current),
        graph: graphRef.current,
      });
      setStatus("saved");
      setLastSaved(new Date());
      retryCountRef.current = 0;
      setRetryCount(0);
      clearRetryTimer();
    } catch (err) {
      console.error("Autosave failed:", err);
      setStatus("error");

      // Schedule automatic retry with exponential backoff
      const currentRetry = retryCountRef.current;
      const backoffMs = Math.min(
        RETRY_BASE_MS * Math.pow(2, currentRetry),
        RETRY_MAX_MS,
      );
      retryCountRef.current = currentRetry + 1;
      setRetryCount(currentRetry + 1);

      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        void doSave();
      }, backoffMs);
    }
  }, [clearRetryTimer]);

  const retry = useCallback(() => {
    clearRetryTimer();
    retryCountRef.current = 0;
    setRetryCount(0);
    void doSave();
  }, [doSave, clearRetryTimer]);

  const scheduleSave = useCallback(() => {
    if (!projectIdRef.current) return;
    clearTimeout(timerRef.current);
    clearRetryTimer();
    retryCountRef.current = 0;
    setRetryCount(0);
    setStatus("unsaved");
    timerRef.current = setTimeout(() => {
      void doSave();
    }, delayMs);
  }, [delayMs, doSave, clearRetryTimer]);

  // Reset initial load flag when project changes
  useEffect(() => {
    initialLoadRef.current = true;
    lastObservedRef.current = null;
    setStatus("idle");
    setLastSaved(null);
    retryCountRef.current = 0;
    setRetryCount(0);
  }, [projectId]);

  // Watch for state changes
  useEffect(() => {
    // Skip auto-save on initial load
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      lastObservedRef.current = { nodes, graph, transform };
      return;
    }

    const previous = lastObservedRef.current;
    lastObservedRef.current = { nodes, graph, transform };
    if (
      previous &&
      persistableNodesEqual(previous.nodes, nodes) &&
      graphEqual(previous.graph, graph) &&
      transformEqual(previous.transform, transform)
    ) {
      return;
    }

    scheduleSave();
  }, [projectId, nodes, graph, transform, scheduleSave]);

  // beforeunload warning for unsaved/error states
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (status === "unsaved" || status === "error") {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      clearRetryTimer();
    };
  }, [clearRetryTimer]);

  return { status, lastSaved, forceSave: doSave, retryCount, retry };
}
