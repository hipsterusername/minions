/**
 * Pure logic tests for the markdown editor keymap commands.
 * No DOM, no React — exercise CodeMirror commands directly against an
 * EditorState.
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import type { EditorView, Command } from "@codemirror/view";
import { wrapWith, saveCommand, docText } from "./markdown-keymap.ts";

function stateOf(doc: string, selection: { from: number; to?: number } | number) {
  const sel =
    typeof selection === "number"
      ? EditorSelection.cursor(selection)
      : EditorSelection.range(selection.from, selection.to ?? selection.from);
  return EditorState.create({ doc, selection: { anchor: sel.anchor, head: sel.head } });
}

/**
 * Drive a Command against a minimal stub. CodeMirror's Command type is
 * `(view: EditorView) => boolean`, but at runtime our commands only touch
 * `.state` and `.dispatch`. We cast the stub through `unknown` so the
 * type checker is happy without pulling in the full EditorView surface.
 */
function runCommand(state: EditorState, command: Command): EditorState {
  let next: EditorState = state;
  const stub = {
    state,
    dispatch: (tr: unknown) => {
      const t = tr as { state: EditorState };
      next = t.state;
    },
  } as unknown as EditorView;
  command(stub);
  return next;
}

describe("wrapWith", () => {
  it("wraps a selection with the given markers", () => {
    const state = stateOf("hello world", { from: 0, to: 5 });
    const next = runCommand(state, wrapWith("**", "**"));
    expect(docText(next)).toBe("**hello** world");
    expect(next.selection.main.from).toBe(2);
    expect(next.selection.main.to).toBe(7);
  });

  it("inserts an empty pair and places the cursor between markers when there is no selection", () => {
    const state = stateOf("ab", 1);
    const next = runCommand(state, wrapWith("**", "**"));
    expect(docText(next)).toBe("a****b");
    expect(next.selection.main.from).toBe(3);
    expect(next.selection.main.to).toBe(3);
  });

  it("unwraps when the selection is already surrounded by the markers", () => {
    const state = stateOf("foo**bar**baz", { from: 5, to: 8 }); // "bar"
    const next = runCommand(state, wrapWith("**", "**"));
    expect(docText(next)).toBe("foobarbaz");
    expect(next.selection.main.from).toBe(3);
    expect(next.selection.main.to).toBe(6);
  });

  it("supports asymmetric markers (e.g. inline code)", () => {
    const state = stateOf("code here", { from: 0, to: 4 });
    const next = runCommand(state, wrapWith("`", "`"));
    expect(docText(next)).toBe("`code` here");
  });
});

describe("saveCommand", () => {
  it("invokes the onSave callback and returns true", () => {
    const onSave = vi.fn();
    const command = saveCommand(onSave);
    const state = stateOf("x", 0);
    let dispatched = false;
    const stub = {
      state,
      dispatch: () => {
        dispatched = true;
      },
    } as unknown as EditorView;
    const result = command(stub);
    expect(result).toBe(true);
    expect(onSave).toHaveBeenCalledOnce();
    // saveCommand does not dispatch any changes — it only invokes the
    // host's save flow.
    expect(dispatched).toBe(false);
  });
});

describe("docText", () => {
  it("returns the editor's current document text", () => {
    expect(docText(stateOf("hello", 0))).toBe("hello");
  });
});
