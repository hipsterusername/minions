/**
 * Markdown editor keymap commands — pure CodeMirror 6 transactions.
 *
 * Replaces the hand-rolled textarea selection logic in `MarkdownNode.tsx`
 * (`wrapSelection`, `handleTabIndent`, `handleEnterKey`) with idiomatic
 * editor commands that operate on the CodeMirror `EditorState`.
 *
 * Why a separate file: the wrap-around-selection logic has interesting
 * branching (unwrap if already wrapped, cursor handling for empty
 * selections, multi-range selections) that is easier to unit-test
 * without a DOM by exercising the `Command` directly against an
 * `EditorState`.
 */

import type { EditorState, ChangeSpec } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";

/**
 * Build a command that wraps each selection range with `before` / `after`,
 * or unwraps it if the markers are already present immediately outside
 * the selection.
 *
 * Examples:
 *  - cursor in `foo|bar` + wrap `**`,`**` → `foo****bar` and cursor sits
 *    between the markers.
 *  - selection over `bar` in `foo[bar]baz` + wrap `**`,`**` →
 *    `foo**bar**baz`, selection still spans `bar`.
 *  - selection over `bar` in `foo**[bar]**baz` + wrap `**`,`**` →
 *    `foobarbaz` (unwrap).
 */
export function wrapWith(before: string, after: string): Command {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    const ranges = state.selection.ranges.map((range) => {
      const { from, to } = range;
      const selected = state.sliceDoc(from, to);

      const hasPrefix =
        from >= before.length &&
        state.sliceDoc(from - before.length, from) === before;
      const hasSuffix =
        to + after.length <= state.doc.length &&
        state.sliceDoc(to, to + after.length) === after;

      if (hasPrefix && hasSuffix && selected.length > 0) {
        // Unwrap: delete the markers around the selection
        changes.push({ from: from - before.length, to: from, insert: "" });
        changes.push({ from: to, to: to + after.length, insert: "" });
        return EditorSelection.range(
          from - before.length,
          to - before.length,
        );
      }

      // Wrap: insert the markers around the selection
      changes.push({ from, insert: before });
      changes.push({ from: to, insert: after });
      if (selected.length === 0) {
        // Place cursor between the two markers
        return EditorSelection.cursor(from + before.length);
      }
      return EditorSelection.range(
        from + before.length,
        to + before.length,
      );
    });

    dispatch(
      state.update({
        changes,
        selection: EditorSelection.create(ranges, state.selection.mainIndex),
        scrollIntoView: true,
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

/**
 * Build a command that runs `onSave` if there are unsaved changes (caller
 * decides), or opens the save-as dialog otherwise. Wired up via the
 * editor's `onSave` / `onSaveAs` props.
 */
export function saveCommand(onSave: () => void): Command {
  return () => {
    onSave();
    return true;
  };
}

export interface MarkdownKeymapHandlers {
  onSave: () => void;
}

/**
 * Return the project-specific markdown keybindings. Designed to be
 * `Prec.high()`-wrapped by the caller so they take precedence over
 * CodeMirror defaults that share the same chord (notably Cmd+B which
 * the default keymap doesn't bind, but we want priority anyway).
 */
export function markdownKeymap({ onSave }: MarkdownKeymapHandlers): KeyBinding[] {
  return [
    { key: "Mod-b", run: wrapWith("**", "**") },
    { key: "Mod-i", run: wrapWith("*", "*") },
    { key: "Mod-e", run: wrapWith("`", "`") },
    { key: "Mod-s", run: saveCommand(onSave), preventDefault: true },
  ];
}

/**
 * Read the current document content from an `EditorState`. Pure helper
 * exposed for tests so we don't reach into the EditorView from outside.
 */
export function docText(state: EditorState): string {
  return state.doc.toString();
}
