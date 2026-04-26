/**
 * Tests for `useKanban` — load, save (debounced), and migration of stored
 * boards across older schema versions.
 *
 * Uses jsdom for localStorage. Suffix is `.dom.test.ts` because the file
 * has no JSX but does need a browser environment (see vitest.config.ts).
 */

import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useKanban } from "./use-kanban.ts";
import { DEFAULT_COLUMNS, type KanbanBoard, type KanbanCard } from "./kanban-types.ts";

const STORAGE_KEY = (projectId: string) => `kanban-${projectId}`;

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "c1",
    title: "Test",
    description: "",
    subtasks: [],
    context: "",
    priority: "medium",
    columnId: "backlog",
    createdAt: 0,
    model: "sonnet",
    permissionMode: "auto",
    worktreeIsolation: false,
    skillIds: [],
    skillValues: {},
    linkedContextNodeIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("useKanban — load", () => {
  it("returns the default board when localStorage is empty", () => {
    const { result } = renderHook(() => useKanban("proj-a"));
    expect(result.current.board.columns).toEqual(DEFAULT_COLUMNS);
    expect(result.current.board.cards).toEqual([]);
  });

  it("hydrates from localStorage when an entry exists for the project", () => {
    const stored: KanbanBoard = {
      columns: DEFAULT_COLUMNS,
      cards: [makeCard({ id: "stored", title: "Stored" })],
    };
    localStorage.setItem(STORAGE_KEY("proj-b"), JSON.stringify(stored));

    const { result } = renderHook(() => useKanban("proj-b"));
    expect(result.current.board.cards).toHaveLength(1);
    expect(result.current.board.cards[0]?.id).toBe("stored");
  });

  it("falls back to default when stored JSON is corrupt", () => {
    localStorage.setItem(STORAGE_KEY("proj-c"), "not-json{{{");
    const { result } = renderHook(() => useKanban("proj-c"));
    expect(result.current.board.cards).toEqual([]);
  });

  it("falls back to default when stored payload is missing required fields", () => {
    localStorage.setItem(STORAGE_KEY("proj-d"), JSON.stringify({ foo: "bar" }));
    const { result } = renderHook(() => useKanban("proj-d"));
    expect(result.current.board.columns).toEqual(DEFAULT_COLUMNS);
  });
});

describe("useKanban — save (debounced)", () => {
  it("does not write to storage on initial mount", () => {
    renderHook(() => useKanban("proj-save-1"));
    // Allow any pending timers to flush.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(localStorage.getItem(STORAGE_KEY("proj-save-1"))).toBeNull();
  });

  it("persists the board after the debounce window elapses on dispatch", () => {
    const { result } = renderHook(() => useKanban("proj-save-2"));
    act(() => {
      result.current.dispatch({
        type: "ADD_CARD",
        card: makeCard({ id: "added" }),
      });
    });

    // Before the debounce window, nothing has been written.
    expect(localStorage.getItem(STORAGE_KEY("proj-save-2"))).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const raw = localStorage.getItem(STORAGE_KEY("proj-save-2"));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as KanbanBoard;
    expect(parsed.cards.map((c) => c.id)).toEqual(["added"]);
  });

  it("scopes storage by projectId", () => {
    const { result } = renderHook(() => useKanban("proj-X"));
    act(() => {
      result.current.dispatch({
        type: "ADD_CARD",
        card: makeCard({ id: "x-card" }),
      });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(localStorage.getItem(STORAGE_KEY("proj-X"))).not.toBeNull();
    expect(localStorage.getItem(STORAGE_KEY("proj-Y"))).toBeNull();
  });
});

describe("useKanban — migration", () => {
  it("renames a 'review' column to 'halted' and tags affected cards as idle_review", () => {
    const stored: KanbanBoard = {
      columns: [
        { id: "backlog", title: "Backlog", color: "#000" },
        { id: "in-progress", title: "In Progress", color: "#000" },
        { id: "review", title: "Review", color: "#000" },
        { id: "history", title: "Done", color: "#000" },
      ],
      cards: [makeCard({ id: "r", columnId: "review" })],
    };
    localStorage.setItem(STORAGE_KEY("mig-1"), JSON.stringify(stored));

    const { result } = renderHook(() => useKanban("mig-1"));
    const board = result.current.board;

    expect(board.columns.some((c) => c.id === "review")).toBe(false);
    expect(board.columns.some((c) => c.id === "halted")).toBe(true);
    const card = board.cards.find((c) => c.id === "r");
    expect(card?.columnId).toBe("halted");
    expect(card?.blockReason).toBe("idle_review");
  });

  it("collapses a 'blocked' column into 'halted'", () => {
    const stored: KanbanBoard = {
      columns: [
        { id: "backlog", title: "Backlog", color: "#000" },
        { id: "in-progress", title: "In Progress", color: "#000" },
        { id: "blocked", title: "Blocked", color: "#000" },
        { id: "history", title: "Done", color: "#000" },
      ],
      cards: [makeCard({ id: "b", columnId: "blocked" })],
    };
    localStorage.setItem(STORAGE_KEY("mig-2"), JSON.stringify(stored));

    const { result } = renderHook(() => useKanban("mig-2"));
    const board = result.current.board;

    expect(board.columns.some((c) => c.id === "blocked")).toBe(false);
    expect(board.columns.some((c) => c.id === "halted")).toBe(true);
    expect(board.cards.find((c) => c.id === "b")?.columnId).toBe("halted");
  });

  it("removes the stale 'ready' column and reassigns its cards to backlog", () => {
    const stored: KanbanBoard = {
      columns: [
        { id: "backlog", title: "Backlog", color: "#000" },
        { id: "ready", title: "Ready", color: "#000" },
        { id: "in-progress", title: "In Progress", color: "#000" },
        { id: "halted", title: "Halted", color: "#000" },
        { id: "history", title: "History", color: "#000" },
      ],
      cards: [makeCard({ id: "ready-card", columnId: "ready" })],
    };
    localStorage.setItem(STORAGE_KEY("mig-3"), JSON.stringify(stored));

    const { result } = renderHook(() => useKanban("mig-3"));
    expect(
      result.current.board.columns.some((c) => c.id === "ready"),
    ).toBe(false);
    expect(
      result.current.board.cards.find((c) => c.id === "ready-card")?.columnId,
    ).toBe("backlog");
  });

  it("syncs column titles with the current defaults", () => {
    const stored: KanbanBoard = {
      columns: [
        { id: "backlog", title: "TODO", color: "#000" },
        { id: "in-progress", title: "Doing", color: "#000" },
        { id: "halted", title: "Halted", color: "#000" },
        { id: "history", title: "Done", color: "#000" },
      ],
      cards: [],
    };
    localStorage.setItem(STORAGE_KEY("mig-4"), JSON.stringify(stored));

    const { result } = renderHook(() => useKanban("mig-4"));
    const titles = Object.fromEntries(
      result.current.board.columns.map((c) => [c.id, c.title]),
    );
    expect(titles["backlog"]).toBe("Backlog");
    expect(titles["in-progress"]).toBe("In Progress");
    expect(titles["history"]).toBe("Agent History");
  });

  it("backfills missing default columns so cards never become invisible", () => {
    const stored: KanbanBoard = {
      columns: [
        { id: "backlog", title: "Backlog", color: "#000" },
        { id: "in-progress", title: "In Progress", color: "#000" },
        // halted + history missing
      ],
      cards: [
        makeCard({ id: "orphan", columnId: "halted" }),
      ],
    };
    localStorage.setItem(STORAGE_KEY("mig-5"), JSON.stringify(stored));

    const { result } = renderHook(() => useKanban("mig-5"));
    const ids = result.current.board.columns.map((c) => c.id);
    expect(ids).toContain("halted");
    expect(ids).toContain("history");
  });
});
