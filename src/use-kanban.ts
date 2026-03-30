import { useReducer, useEffect, useRef, useCallback } from "react";
import { kanbanReducer, DEFAULT_COLUMNS } from "./kanban-types.ts";
import type { KanbanBoard, KanbanAction } from "./kanban-types.ts";

const STORAGE_PREFIX = "kanban-";
const SAVE_DEBOUNCE_MS = 500;

function loadBoard(projectId: string): KanbanBoard {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "columns" in parsed &&
        "cards" in parsed &&
        Array.isArray((parsed as KanbanBoard).columns) &&
        Array.isArray((parsed as KanbanBoard).cards)
      ) {
        return parsed as KanbanBoard;
      }
    }
  } catch {
    // Ignore parse errors, return default
  }
  return { columns: DEFAULT_COLUMNS, cards: [] };
}

export function useKanban(projectId: string): {
  board: KanbanBoard;
  dispatch: React.Dispatch<KanbanAction>;
} {
  const [board, dispatch] = useReducer(kanbanReducer, projectId, loadBoard);

  const boardRef = useRef(board);
  boardRef.current = board;

  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const initialRef = useRef(true);

  const saveToStorage = useCallback(() => {
    localStorage.setItem(
      `${STORAGE_PREFIX}${projectId}`,
      JSON.stringify(boardRef.current),
    );
  }, [projectId]);

  // Save on state change (debounced)
  useEffect(() => {
    if (initialRef.current) {
      initialRef.current = false;
      return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(saveToStorage, SAVE_DEBOUNCE_MS);
  }, [board, saveToStorage]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
    };
  }, []);

  // Reload when projectId changes
  useEffect(() => {
    initialRef.current = true;
    const loaded = loadBoard(projectId);
    dispatch({ type: "SET_BOARD", board: loaded });
  }, [projectId]);

  return { board, dispatch };
}
