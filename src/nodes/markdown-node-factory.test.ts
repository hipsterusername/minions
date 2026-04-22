/**
 * createMarkdownNodeFromText — the text-paste factory. Tests the
 * pure placement + dispatch behavior; the Canvas paste effect is a
 * thin wrapper over this.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createMarkdownNodeFromText,
  MARKDOWN_PASTE_TITLE,
} from "./markdown-node-factory.ts";
import type {
  CanvasAction,
  CanvasNode,
  CanvasTransform,
} from "../types.ts";

function identityTransform(): CanvasTransform {
  return { x: 0, y: 0, scale: 1 };
}

describe("createMarkdownNodeFromText", () => {
  it("returns false for empty / whitespace-only text and dispatches nothing", () => {
    const dispatch = vi.fn<(action: CanvasAction) => void>();
    const setSelectedIds = vi.fn<(ids: Set<string>) => void>();

    expect(
      createMarkdownNodeFromText("", dispatch, setSelectedIds, identityTransform(), []),
    ).toBe(false);
    expect(
      createMarkdownNodeFromText("   \n  \t  ", dispatch, setSelectedIds, identityTransform(), []),
    ).toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
    expect(setSelectedIds).not.toHaveBeenCalled();
  });

  it("dispatches ADD_NODE with the pasted text as markdown content and selects the new node", () => {
    const dispatch = vi.fn<(action: CanvasAction) => void>();
    const setSelectedIds = vi.fn<(ids: Set<string>) => void>();

    const ok = createMarkdownNodeFromText(
      "Hello **world**",
      dispatch,
      setSelectedIds,
      identityTransform(),
      [],
      { x: 200, y: 150 },
    );

    expect(ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0]?.[0];
    if (action?.type !== "ADD_NODE") throw new Error("expected ADD_NODE");
    expect(action.node.type).toBe("markdown");
    expect(action.node.size).toEqual({ width: 420, height: 380 });
    const data = action.node.data as { title: string; content: string; viewMode: string };
    expect(data.content).toBe("Hello **world**");
    expect(data.title).toBe(MARKDOWN_PASTE_TITLE);
    expect(data.viewMode).toBe("edit");

    expect(setSelectedIds).toHaveBeenCalledTimes(1);
    const ids = setSelectedIds.mock.calls[0]?.[0];
    expect(ids).toBeInstanceOf(Set);
    expect(ids?.has(action.node.id)).toBe(true);
  });

  it("centers the node on the supplied world point", () => {
    const dispatch = vi.fn<(action: CanvasAction) => void>();
    const setSelectedIds = vi.fn<(ids: Set<string>) => void>();

    createMarkdownNodeFromText(
      "note",
      dispatch,
      setSelectedIds,
      identityTransform(),
      [],
      { x: 1000, y: 500 },
    );

    const action = dispatch.mock.calls[0]?.[0];
    if (action?.type !== "ADD_NODE") throw new Error("expected ADD_NODE");
    // When no existing nodes conflict, the raw centered position is used
    // (modulo grid snapping inside findNonOverlappingPosition).
    // Width 420 → raw X = 1000 - 210 = 790; height 380 → raw Y = 500 - 190 = 310.
    // findNonOverlappingPosition snaps to the 24px grid.
    expect(action.node.position.x).toBeGreaterThanOrEqual(790 - 24);
    expect(action.node.position.x).toBeLessThanOrEqual(790 + 24);
    expect(action.node.position.y).toBeGreaterThanOrEqual(310 - 24);
    expect(action.node.position.y).toBeLessThanOrEqual(310 + 24);
  });

  it("avoids overlapping existing nodes at the same anchor", () => {
    const dispatch = vi.fn<(action: CanvasAction) => void>();
    const setSelectedIds = vi.fn<(ids: Set<string>) => void>();

    const occupant: CanvasNode = {
      id: "occupant",
      type: "markdown",
      position: { x: 790, y: 310 },
      size: { width: 420, height: 380 },
      data: { title: "", content: "", viewMode: "edit" },
    };

    createMarkdownNodeFromText(
      "note",
      dispatch,
      setSelectedIds,
      identityTransform(),
      [occupant],
      { x: 1000, y: 500 },
    );

    const action = dispatch.mock.calls[0]?.[0];
    if (action?.type !== "ADD_NODE") throw new Error("expected ADD_NODE");
    // The new node must not intersect the occupant rect.
    const { x, y } = action.node.position;
    const overlapsX = x < 790 + 420 && x + 420 > 790;
    const overlapsY = y < 310 + 380 && y + 380 > 310;
    expect(overlapsX && overlapsY).toBe(false);
  });
});
