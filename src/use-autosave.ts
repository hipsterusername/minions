import { useRef, useEffect, useState, useCallback } from "react";
import type { CanvasNode, CanvasTransform } from "./types.ts";
import { saveProjectState } from "./api.ts";

export type SaveStatus = "saved" | "saving" | "unsaved" | "error" | "idle";

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;

interface AutosaveResult {
  status: SaveStatus;
  lastSaved: Date | null;
  forceSave: () => void;
  retryCount: number;
  retry: () => void;
}

export function useAutosave(
  projectId: string | null,
  nodes: CanvasNode[],
  transform: CanvasTransform,
  delayMs = 1500,
): AutosaveResult {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nodesRef = useRef(nodes);
  const transformRef = useRef(transform);
  const projectIdRef = useRef(projectId);
  const initialLoadRef = useRef(true);
  const retryCountRef = useRef(0);

  nodesRef.current = nodes;
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
        nodes: nodesRef.current,
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

  // Watch for state changes
  useEffect(() => {
    // Skip auto-save on initial load
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      return;
    }
    scheduleSave();
  }, [nodes, transform, scheduleSave]);

  // Reset initial load flag when project changes
  useEffect(() => {
    initialLoadRef.current = true;
    setStatus("idle");
    setLastSaved(null);
    retryCountRef.current = 0;
    setRetryCount(0);
  }, [projectId]);

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
