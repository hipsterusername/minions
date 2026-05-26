/**
 * MarkdownEditor — controlled CodeMirror 6 surface tuned for the
 * Markdown card on the canvas.
 *
 * Why a wrapper component (and not raw CodeMirror in MarkdownNode):
 *  - Keeps the (already large) MarkdownNode.tsx focused on canvas
 *    concerns (header, save flow, resize, collapse).
 *  - Encapsulates the lifecycle ritual of constructing an `EditorView`,
 *    syncing controlled `value` prop into the view without round-trip
 *    flicker, and tearing it down on unmount.
 *  - Lets us unit-test the editor surface separately from the node.
 *
 * Theme: the editor element is styled to be visually indistinguishable
 * from the previous `<textarea>` (font, padding, caret, selection
 * color). Differences vs. textarea: now we get markdown syntax
 * highlighting, smart Enter inside lists, find/replace (Mod-f), and
 * undo/redo with a real history stack.
 */

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdownKeymap } from "./markdown-keymap.ts";

export interface MarkdownEditorProps {
  /** Current document content (controlled). */
  value: string;
  /** Called with the new text whenever the user edits. */
  onChange: (next: string) => void;
  /** Called when the user presses Cmd+S / Ctrl+S. */
  onSave?: () => void;
  /** Placeholder shown when the document is empty. */
  placeholder?: string;
  /** Forwarded to the wrapper div — used by tests and parent layout. */
  className?: string;
  /**
   * Forwarded to the wrapper div. The canvas pan/zoom handler skips
   * elements whose ancestors carry `data-scroll-capture`, and the node
   * drag handler skips `data-no-drag`. The wrapper carries both.
   */
  ariaLabel?: string;
}

/**
 * Build the project's editor theme. Matches the prior `.md-textarea`
 * appearance pixel-for-pixel where it matters (padding, font, caret).
 */
const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg-primary)",
      color: "var(--text-primary)",
      fontSize: "13.5px",
      fontFamily: "var(--font-sans)",
      lineHeight: "1.75",
      letterSpacing: "0.005em",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-sans)",
      lineHeight: "1.75",
      padding: "14px 20px",
      overflow: "auto",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      padding: "0",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-line": {
      padding: "0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        background: "rgba(240, 136, 62, 0.25) !important",
      },
    ".cm-activeLine": {
      backgroundColor: "transparent",
    },
    ".cm-placeholder": {
      color: "var(--text-muted)",
      fontStyle: "italic",
    },
    // Code blocks/inline code in markdown should feel monospaced.
    ".cm-line .tok-monospace, .cm-line .ͼo": {
      fontFamily: "var(--font-mono)",
    },
  },
  { dark: false },
);

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  placeholder,
  className,
  ariaLabel,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest callbacks accessible from the long-lived view so we
  // don't have to rebuild the EditorState every render.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // Build the editor once on mount. `value` is treated as the *initial*
  // value here; subsequent prop changes are synced in the next effect.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSpecialChars(),
        highlightSelectionMatches(),
        bracketMatching(),
        indentOnInput(),
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage }),
        placeholderExtension(placeholder ?? ""),
        keymap.of([
          ...markdownKeymap({ onSave: () => onSaveRef.current?.() }),
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    // Match the previous textarea behaviour: when the editor mounts
    // (entering Write or Split mode), give it focus immediately so the
    // user can start typing without an extra click.
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We deliberately ignore `value` / `placeholder` here — they're
    // applied as the initial state, then synced via the effect below
    // (for `value`) or by re-mount only (for `placeholder`, which
    // realistically never changes after creation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external `value` changes into the editor *only when they
  // differ from the current doc*. This prevents the controlled-component
  // feedback loop (onChange → setState → prop → dispatch → onChange…)
  // and keeps the caret position stable during user typing.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={className}
      data-no-drag
      data-scroll-capture
      aria-label={ariaLabel}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}
