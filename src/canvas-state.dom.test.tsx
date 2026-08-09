/**
 * `useCanvasHistory` — DOM-env coverage for the undo/redo hook.
 *
 * The pure-reducer tests in `canvas-state.test.ts` cover every
 * `canvasReducer` action. This file targets the React hook that wraps
 * the reducer with an undo/redo stack — a surface the §6.4 mutation-test
 * rotation flagged with 39 no-coverage mutants on lines 66-128.
 *
 * Boundary: real React via `@testing-library/react`. No mocks.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import {
  generateId,
  useCanvasHistory,
  type CanvasHistoryState,
} from "./canvas-state.ts";
import type { CanvasAction } from "./types.ts";
import { makeNode } from "../tests/fixtures/builders.ts";

interface ProbeProps {
  onState: (state: CanvasHistoryState) => void;
}

/** Minimal probe component that forwards every render's hook state. */
function Probe({ onState }: ProbeProps) {
  const handle = useCanvasHistory();
  useEffect(() => {
    onState(handle);
  });
  return null;
}

let last: CanvasHistoryState | null = null;
function mount() {
  last = null;
  const { unmount } = render(
    <Probe
      onState={(s) => {
        last = s;
      }}
    />,
  );
  if (!last) throw new Error("hook never produced state");
  return { unmount, get state() { return last as CanvasHistoryState; } };
}

afterEach(() => {
  last = null;
});

describe("useCanvasHistory — initial state", () => {
  it("starts with no nodes and no history", () => {
    const h = mount();
    expect(h.state.nodes).toEqual([]);
    expect(h.state.canUndo).toBe(false);
    expect(h.state.canRedo).toBe(false);
  });
});

describe("useCanvasHistory — dispatch + history tracking", () => {
  it("ADD_NODE pushes the previous state onto past and clears future", () => {
    const h = mount();
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("n1") });
    });
    expect(h.state.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(h.state.canUndo).toBe(true);
    expect(h.state.canRedo).toBe(false);
  });

  it("SET_NODES bypasses the history stack — neither past nor future change", () => {
    const h = mount();
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("a") });
    });
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("b") });
    });
    act(() => h.state.undo());
    expect(h.state.canRedo).toBe(true);

    act(() => {
      h.state.dispatch({
        type: "SET_NODES",
        nodes: [makeNode("from-disk")],
      });
    });
    expect(h.state.nodes.map((n) => n.id)).toEqual(["from-disk"]);
    // Original code: SET_NODES is NOT a HISTORY_ACTION → future preserved.
    // Mutated `if (true)` would clear future and toggle canRedo to false.
    expect(h.state.canRedo).toBe(true);
  });

  it("each of the six history actions pushes to past", () => {
    const actions: CanvasAction[] = [
      { type: "ADD_NODE", node: makeNode("a") },
      { type: "REMOVE_NODE", id: "a" },
      // After REMOVE_NODE the list is empty — re-add to allow MOVE/RESIZE/UPDATE.
      { type: "ADD_NODE", node: makeNode("b") },
      { type: "MOVE_NODE", id: "b", position: { x: 10, y: 10 } },
      { type: "RESIZE_NODE", id: "b", size: { width: 100, height: 50 } },
      { type: "UPDATE_NODE_DATA", id: "b", data: { label: "B!" } },
      { type: "MOVE_GROUP", moves: [{ id: "b", position: { x: 20, y: 20 } }] },
    ];

    const h = mount();
    for (const a of actions) {
      act(() => {
        h.state.dispatch(a);
      });
    }
    // 7 dispatches above; each was a HISTORY action, so past has 7 entries.
    expect(h.state.canUndo).toBe(true);
    let undoCount = 0;
    while (h.state.canUndo) {
      act(() => h.state.undo());
      undoCount += 1;
      if (undoCount > 20) throw new Error("undo loop did not terminate");
    }
    expect(undoCount).toBe(actions.length);
  });
});

describe("useCanvasHistory — undo / redo", () => {
  it("undo restores the previous state and pushes the current onto future", () => {
    const h = mount();
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("a") });
    });
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("b") });
    });
    expect(h.state.nodes.map((n) => n.id)).toEqual(["a", "b"]);

    act(() => h.state.undo());
    expect(h.state.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(h.state.canRedo).toBe(true);
  });

  it("redo replays the undone action", () => {
    const h = mount();
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("a") });
    });
    act(() => h.state.undo());
    expect(h.state.nodes).toEqual([]);
    expect(h.state.canRedo).toBe(true);

    act(() => h.state.redo());
    expect(h.state.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(h.state.canRedo).toBe(false);
    expect(h.state.canUndo).toBe(true);
  });

  it("undo with empty past is a no-op (does NOT pop from an empty stack)", () => {
    const h = mount();
    expect(h.state.canUndo).toBe(false);
    act(() => h.state.undo());
    expect(h.state.nodes).toEqual([]);
    expect(h.state.canUndo).toBe(false);
    expect(h.state.canRedo).toBe(false);
  });

  it("redo with empty future is a no-op", () => {
    const h = mount();
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("a") });
    });
    expect(h.state.canRedo).toBe(false);
    act(() => h.state.redo());
    expect(h.state.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(h.state.canRedo).toBe(false);
  });

  it("a fresh dispatch after undo clears the future stack", () => {
    const h = mount();
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("a") });
    });
    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("b") });
    });
    act(() => h.state.undo());
    expect(h.state.canRedo).toBe(true);

    act(() => {
      h.state.dispatch({ type: "ADD_NODE", node: makeNode("c") });
    });
    expect(h.state.canRedo).toBe(false);
    expect(h.state.nodes.map((n) => n.id)).toEqual(["a", "c"]);
  });
});

describe("useCanvasHistory — MAX_HISTORY cap", () => {
  it("retains all 50 entries at the exact limit", () => {
    const h = mount();
    for (let i = 0; i < 50; i++) {
      act(() => {
        h.state.dispatch({ type: "ADD_NODE", node: makeNode(`n${i}`) });
      });
    }

    let undoCount = 0;
    while (h.state.canUndo) {
      act(() => h.state.undo());
      undoCount += 1;
      if (undoCount > 50) throw new Error("undo loop exceeded the history limit");
    }

    expect(undoCount).toBe(50);
    expect(h.state.nodes).toEqual([]);
  });

  it("trims past to the most recent 50 entries when the limit is exceeded", () => {
    const h = mount();
    // 60 dispatches → past should cap at 50; the oldest 10 fall off.
    for (let i = 0; i < 60; i++) {
      act(() => {
        h.state.dispatch({ type: "ADD_NODE", node: makeNode(`n${i}`) });
      });
    }
    // After 60 ADD_NODEs the list has 60 nodes.
    expect(h.state.nodes).toHaveLength(60);

    // Undo 50 times — past has 50 entries to consume.
    let undoCount = 0;
    while (h.state.canUndo) {
      act(() => h.state.undo());
      undoCount += 1;
      if (undoCount > 60) throw new Error("undo loop did not terminate");
    }
    expect(undoCount).toBe(50);
    // After 50 undos we're back to the 11th-oldest snapshot, which had 10
    // nodes (n0..n9). Past entries beyond that were discarded by the cap.
    expect(h.state.nodes).toHaveLength(10);
    expect(h.state.nodes.map((n) => n.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `n${i}`),
    );
  });
});

describe("generateId", () => {
  it("returns a non-empty string", () => {
    expect(typeof generateId()).toBe("string");
    expect(generateId().length).toBeGreaterThan(0);
  });

  it("counter portion is strictly increasing across consecutive calls", () => {
    // The id format is `<dateBase36>-<counterBase36>`. Splitting on '-'
    // and parsing the second segment lets us verify monotonicity, which
    // mutation testing flagged as unobserved.
    const a = generateId();
    const b = generateId();
    const c = generateId();
    const aCounter = Number.parseInt(a.split("-")[1] ?? "", 36);
    const bCounter = Number.parseInt(b.split("-")[1] ?? "", 36);
    const cCounter = Number.parseInt(c.split("-")[1] ?? "", 36);
    expect(bCounter).toBeGreaterThan(aCounter);
    expect(cCounter).toBeGreaterThan(bCounter);
  });
});
