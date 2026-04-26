/**
 * Unit tests for `kanbanReducer`.
 *
 * Every action in the `KanbanAction` union has a test. The CLEAR_ARCHIVE
 * case is the regression test for the "Clear Agent History" bug — the
 * button-click handler in `KanbanBoard.tsx` was wired to an undefined
 * setter so the dispatch never fired. The reducer itself was always
 * correct; pinning it down here means a future rename can't quietly
 * change the semantics.
 */

import { describe, it, expect } from "vitest";
import {
  kanbanReducer,
  DEFAULT_COLUMNS,
  type KanbanBoard,
  type KanbanCard,
} from "./kanban-types.ts";

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "c1",
    title: "Test card",
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

function makeBoard(cards: KanbanCard[] = []): KanbanBoard {
  return { columns: DEFAULT_COLUMNS, cards };
}

describe("kanbanReducer", () => {
  describe("ADD_CARD", () => {
    it("appends the card and does not mutate input", () => {
      const initial = makeBoard([makeCard({ id: "a" })]);
      const next = kanbanReducer(initial, {
        type: "ADD_CARD",
        card: makeCard({ id: "b" }),
      });
      expect(next.cards.map((c) => c.id)).toEqual(["a", "b"]);
      expect(initial.cards).toHaveLength(1);
    });
  });

  describe("REMOVE_CARD", () => {
    it("removes the matching card and preserves order", () => {
      const initial = makeBoard([
        makeCard({ id: "a" }),
        makeCard({ id: "b" }),
        makeCard({ id: "c" }),
      ]);
      const next = kanbanReducer(initial, { type: "REMOVE_CARD", cardId: "b" });
      expect(next.cards.map((c) => c.id)).toEqual(["a", "c"]);
    });

    it("is a no-op when the id is unknown", () => {
      const initial = makeBoard([makeCard({ id: "a" })]);
      const next = kanbanReducer(initial, { type: "REMOVE_CARD", cardId: "x" });
      expect(next.cards.map((c) => c.id)).toEqual(["a"]);
    });
  });

  describe("CLEAR_ARCHIVE — regression for Clear Agent History bug", () => {
    it("removes only cards in the history column", () => {
      const initial = makeBoard([
        makeCard({ id: "back", columnId: "backlog" }),
        makeCard({ id: "live", columnId: "in-progress" }),
        makeCard({ id: "wait", columnId: "halted" }),
        makeCard({ id: "done1", columnId: "history" }),
        makeCard({ id: "done2", columnId: "history" }),
      ]);
      const next = kanbanReducer(initial, { type: "CLEAR_ARCHIVE" });
      expect(next.cards.map((c) => c.id)).toEqual(["back", "live", "wait"]);
    });

    it("preserves columns when clearing", () => {
      const initial = makeBoard([makeCard({ id: "d", columnId: "history" })]);
      const next = kanbanReducer(initial, { type: "CLEAR_ARCHIVE" });
      expect(next.columns).toBe(initial.columns);
      expect(next.cards).toEqual([]);
    });

    it("is a no-op when there are no history cards", () => {
      const initial = makeBoard([makeCard({ id: "a", columnId: "backlog" })]);
      const next = kanbanReducer(initial, { type: "CLEAR_ARCHIVE" });
      expect(next.cards).toHaveLength(1);
    });
  });

  describe("UPDATE_CARD", () => {
    it("merges partial data into the matching card", () => {
      const initial = makeBoard([
        makeCard({ id: "a", title: "Old", priority: "low" }),
        makeCard({ id: "b" }),
      ]);
      const next = kanbanReducer(initial, {
        type: "UPDATE_CARD",
        cardId: "a",
        data: { title: "New", priority: "critical" },
      });
      expect(next.cards[0]).toMatchObject({ id: "a", title: "New", priority: "critical" });
      expect(next.cards[1]).toBe(initial.cards[1]);
    });

    it("ignores updates for unknown ids", () => {
      const initial = makeBoard([makeCard({ id: "a", title: "Keep" })]);
      const next = kanbanReducer(initial, {
        type: "UPDATE_CARD",
        cardId: "x",
        data: { title: "Changed" },
      });
      expect(next.cards[0]?.title).toBe("Keep");
    });
  });

  describe("MOVE_CARD", () => {
    it("changes the columnId of the targeted card", () => {
      const initial = makeBoard([makeCard({ id: "a", columnId: "backlog" })]);
      const next = kanbanReducer(initial, {
        type: "MOVE_CARD",
        cardId: "a",
        targetColumnId: "in-progress",
      });
      expect(next.cards.find((c) => c.id === "a")?.columnId).toBe("in-progress");
    });

    it("appends to the target column when no targetIndex given", () => {
      const initial = makeBoard([
        makeCard({ id: "a", columnId: "in-progress" }),
        makeCard({ id: "b", columnId: "backlog" }),
      ]);
      const next = kanbanReducer(initial, {
        type: "MOVE_CARD",
        cardId: "b",
        targetColumnId: "in-progress",
      });
      const inProgress = next.cards.filter((c) => c.columnId === "in-progress");
      expect(inProgress.map((c) => c.id)).toEqual(["a", "b"]);
    });

    it("inserts at the requested index within the target column", () => {
      const initial = makeBoard([
        makeCard({ id: "a", columnId: "in-progress" }),
        makeCard({ id: "b", columnId: "in-progress" }),
        makeCard({ id: "c", columnId: "backlog" }),
      ]);
      const next = kanbanReducer(initial, {
        type: "MOVE_CARD",
        cardId: "c",
        targetColumnId: "in-progress",
        targetIndex: 1,
      });
      const inProgress = next.cards.filter((c) => c.columnId === "in-progress");
      expect(inProgress.map((c) => c.id)).toEqual(["a", "c", "b"]);
    });

    it("is a no-op when cardId is unknown", () => {
      const initial = makeBoard([makeCard({ id: "a", columnId: "backlog" })]);
      const next = kanbanReducer(initial, {
        type: "MOVE_CARD",
        cardId: "x",
        targetColumnId: "in-progress",
      });
      expect(next).toBe(initial);
    });
  });

  describe("TOGGLE_SUBTASK", () => {
    it("flips the done flag on the matching subtask", () => {
      const initial = makeBoard([
        makeCard({
          id: "a",
          subtasks: [
            { id: "s1", title: "one", done: false },
            { id: "s2", title: "two", done: true },
          ],
        }),
      ]);
      const next = kanbanReducer(initial, {
        type: "TOGGLE_SUBTASK",
        cardId: "a",
        subtaskId: "s1",
      });
      expect(next.cards[0]?.subtasks[0]?.done).toBe(true);
      expect(next.cards[0]?.subtasks[1]?.done).toBe(true);
    });
  });

  describe("ADD_SUBTASK", () => {
    it("appends the new subtask", () => {
      const initial = makeBoard([makeCard({ id: "a", subtasks: [] })]);
      const next = kanbanReducer(initial, {
        type: "ADD_SUBTASK",
        cardId: "a",
        subtask: { id: "s1", title: "new", done: false },
      });
      expect(next.cards[0]?.subtasks).toEqual([
        { id: "s1", title: "new", done: false },
      ]);
    });
  });

  describe("REMOVE_SUBTASK", () => {
    it("removes the matching subtask", () => {
      const initial = makeBoard([
        makeCard({
          id: "a",
          subtasks: [
            { id: "s1", title: "one", done: false },
            { id: "s2", title: "two", done: false },
          ],
        }),
      ]);
      const next = kanbanReducer(initial, {
        type: "REMOVE_SUBTASK",
        cardId: "a",
        subtaskId: "s1",
      });
      expect(next.cards[0]?.subtasks.map((s) => s.id)).toEqual(["s2"]);
    });
  });

  describe("SET_BOARD", () => {
    it("replaces the entire board", () => {
      const initial = makeBoard([makeCard({ id: "a" })]);
      const replacement: KanbanBoard = {
        columns: [{ id: "x", title: "X", color: "#000" }],
        cards: [makeCard({ id: "z", columnId: "x" })],
      };
      const next = kanbanReducer(initial, { type: "SET_BOARD", board: replacement });
      expect(next).toBe(replacement);
    });
  });

  describe("BIND_LEADER", () => {
    it("sets leaderNodeId and moves card to in-progress", () => {
      const initial = makeBoard([makeCard({ id: "a", columnId: "backlog" })]);
      const next = kanbanReducer(initial, {
        type: "BIND_LEADER",
        cardId: "a",
        leaderNodeId: "leader-1",
      });
      const card = next.cards[0];
      expect(card?.leaderNodeId).toBe("leader-1");
      expect(card?.columnId).toBe("in-progress");
    });
  });

  describe("COMPLETE_CARD", () => {
    it("moves card to history and stores summary, cost and archived data", () => {
      const initial = makeBoard([
        makeCard({
          id: "a",
          columnId: "in-progress",
          blockReason: "needs_input",
          blockDetail: "stale",
        }),
      ]);
      const next = kanbanReducer(initial, {
        type: "COMPLETE_CARD",
        cardId: "a",
        summary: "All done",
        cost: 0.42,
        archivedTaskName: "task name",
        archivedTurns: 7,
      });
      const card = next.cards[0];
      expect(card?.columnId).toBe("history");
      expect(card?.agentSummary).toBe("All done");
      expect(card?.agentCost).toBeCloseTo(0.42);
      expect(card?.archivedTaskName).toBe("task name");
      expect(card?.archivedTurns).toBe(7);
      expect(card?.blockReason).toBeUndefined();
      expect(card?.blockDetail).toBeUndefined();
    });

    it("preserves prior archived fields when not provided", () => {
      const initial = makeBoard([
        makeCard({
          id: "a",
          columnId: "halted",
          archivedTaskName: "prior",
          archivedTurns: 3,
        }),
      ]);
      const next = kanbanReducer(initial, {
        type: "COMPLETE_CARD",
        cardId: "a",
      });
      expect(next.cards[0]?.archivedTaskName).toBe("prior");
      expect(next.cards[0]?.archivedTurns).toBe(3);
    });
  });

  describe("BLOCK_CARD / HALT_CARD", () => {
    it("BLOCK_CARD moves to halted with reason and detail", () => {
      const initial = makeBoard([makeCard({ id: "a", columnId: "in-progress" })]);
      const next = kanbanReducer(initial, {
        type: "BLOCK_CARD",
        cardId: "a",
        reason: "error",
        detail: "boom",
      });
      const card = next.cards[0];
      expect(card?.columnId).toBe("halted");
      expect(card?.blockReason).toBe("error");
      expect(card?.blockDetail).toBe("boom");
    });

    it("HALT_CARD behaves identically", () => {
      const initial = makeBoard([makeCard({ id: "a", columnId: "in-progress" })]);
      const next = kanbanReducer(initial, {
        type: "HALT_CARD",
        cardId: "a",
        reason: "idle_review",
      });
      const card = next.cards[0];
      expect(card?.columnId).toBe("halted");
      expect(card?.blockReason).toBe("idle_review");
    });
  });

  describe("UNBLOCK_CARD / RESUME_HALTED_CARD", () => {
    it("UNBLOCK_CARD returns card to in-progress and clears halt fields", () => {
      const initial = makeBoard([
        makeCard({
          id: "a",
          columnId: "halted",
          blockReason: "error",
          blockDetail: "boom",
        }),
      ]);
      const next = kanbanReducer(initial, { type: "UNBLOCK_CARD", cardId: "a" });
      const card = next.cards[0];
      expect(card?.columnId).toBe("in-progress");
      expect(card?.blockReason).toBeUndefined();
      expect(card?.blockDetail).toBeUndefined();
    });

    it("RESUME_HALTED_CARD behaves identically", () => {
      const initial = makeBoard([
        makeCard({
          id: "a",
          columnId: "halted",
          blockReason: "needs_input",
          blockDetail: "wat",
        }),
      ]);
      const next = kanbanReducer(initial, {
        type: "RESUME_HALTED_CARD",
        cardId: "a",
      });
      const card = next.cards[0];
      expect(card?.columnId).toBe("in-progress");
      expect(card?.blockReason).toBeUndefined();
      expect(card?.blockDetail).toBeUndefined();
    });
  });

  describe("default branch", () => {
    it("returns state unchanged for unknown actions", () => {
      const initial = makeBoard([makeCard({ id: "a" })]);
      // @ts-expect-error — exercising the default branch
      const next = kanbanReducer(initial, { type: "UNKNOWN" });
      expect(next).toBe(initial);
    });
  });
});
