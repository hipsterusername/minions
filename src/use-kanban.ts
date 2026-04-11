import { useReducer, useEffect, useRef, useCallback } from "react";
import { kanbanReducer, DEFAULT_COLUMNS } from "./kanban-types.ts";
import type { KanbanBoard, KanbanAction } from "./kanban-types.ts";

const STORAGE_PREFIX = "kanban-";
const SAVE_DEBOUNCE_MS = 500;

function migrateBoard(board: KanbanBoard): KanbanBoard {
  let migrated = board;

  // Migrate "review" column → "halted"
  const hasReview = migrated.columns.some((c) => c.id === "review");
  if (hasReview) {
    migrated = {
      columns: migrated.columns
        .filter((c) => c.id !== "review")
        .map((c) => c), // ensure new array
      cards: migrated.cards.map((c) =>
        c.columnId === "review"
          ? { ...c, columnId: "halted", blockReason: "idle_review" as const }
          : c,
      ),
    };
    // Ensure halted column exists
    if (!migrated.columns.some((c) => c.id === "halted")) {
      const idx = migrated.columns.findIndex((c) => c.id === "in-progress");
      const haltedCol = { id: "halted", title: "Halted", color: "#f59e0b" };
      const cols = [...migrated.columns];
      cols.splice(idx + 1, 0, haltedCol);
      migrated = { ...migrated, columns: cols };
    }
  }

  // Migrate "blocked" column → "halted" (consolidation)
  const hasBlocked = migrated.columns.some((c) => c.id === "blocked");
  if (hasBlocked) {
    migrated = {
      columns: migrated.columns.filter((c) => c.id !== "blocked"),
      cards: migrated.cards.map((c) =>
        c.columnId === "blocked"
          ? { ...c, columnId: "halted" }
          : c,
      ),
    };
    // Ensure halted column exists
    if (!migrated.columns.some((c) => c.id === "halted")) {
      const idx = migrated.columns.findIndex((c) => c.id === "in-progress");
      const haltedCol = { id: "halted", title: "Halted", color: "#f59e0b" };
      const cols = [...migrated.columns];
      cols.splice(idx + 1, 0, haltedCol);
      migrated = { ...migrated, columns: cols };
    }
  }

  // Remove stale "ready" column — it was never wired up and has no cards
  const hasReady = migrated.columns.some((c) => c.id === "ready");
  if (hasReady) {
    migrated = {
      columns: migrated.columns.filter((c) => c.id !== "ready"),
      cards: migrated.cards.map((c) =>
        c.columnId === "ready" ? { ...c, columnId: "backlog" } : c,
      ),
    };
  }

  // Sync column titles with defaults (e.g. "Done" → "Agent History")
  migrated = {
    ...migrated,
    columns: migrated.columns.map((col) => {
      const def = DEFAULT_COLUMNS.find((d) => d.id === col.id);
      if (def && col.title !== def.title) {
        return { ...col, title: def.title };
      }
      return col;
    }),
  };

  // Ensure all core columns exist — cards may have been auto-moved to a column
  // (e.g. "halted") that isn't present in an older saved board, making them invisible.
  for (const defaultCol of DEFAULT_COLUMNS) {
    if (!migrated.columns.some((c) => c.id === defaultCol.id)) {
      // Insert at the same position it appears in DEFAULT_COLUMNS
      const defaultIdx = DEFAULT_COLUMNS.indexOf(defaultCol);
      // Find nearest preceding column that already exists to anchor insertion
      let insertAfterIdx = -1;
      for (let i = defaultIdx - 1; i >= 0; i--) {
        const anchorId = DEFAULT_COLUMNS[i].id;
        const found = migrated.columns.findIndex((c) => c.id === anchorId);
        if (found !== -1) { insertAfterIdx = found; break; }
      }
      const cols = [...migrated.columns];
      cols.splice(insertAfterIdx + 1, 0, defaultCol);
      migrated = { ...migrated, columns: cols };
    }
  }

  return migrated;
}

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
        return migrateBoard(parsed as KanbanBoard);
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
