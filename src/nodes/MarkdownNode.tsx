import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { MarkdownPreview } from "../components/MarkdownPreview.tsx";
import { getAuthToken } from "../api.ts";

interface MarkdownData {
  title: string;
  content: string;
  /**
   * "edit"    — CodeMirror editor only.
   * "preview" — rendered HTML only.
   * "split"   — editor + live preview side-by-side.
   */
  viewMode: "edit" | "preview" | "split";
  collapsed?: boolean;
  /** Saved height before collapsing so we can restore on expand */
  expandedHeight?: number;
  /** Last saved relative path (persisted across sessions) */
  savedPath?: string | null;
  /** Content hash at last save — used to detect unsaved changes */
  savedContentHash?: string | null;
  /**
   * Editor pane's fraction of the writing area in Split mode, 0–1.
   * 0.5 = even 50/50 split. Clamped at read time to [SPLIT_MIN,
   * SPLIT_MAX] so neither pane can collapse past 15%. Defaults to 0.5
   * when undefined (existing nodes before this field existed).
   */
  splitRatio?: number;
}

/** Min/max bounds for the resizable Split divider. */
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;
const SPLIT_DEFAULT = 0.5;
const clampSplit = (r: number): number =>
  Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, r));

// ── Graph contract ─────────────────────────────────────

const CONTEXT_OUT_PORT = {
  id: "context-out",
  label: "Context",
  direction: "output" as const,
  protocol: "context" as const,
  maxConnections: 10,
};

const MARKDOWN_CONTRACT: NodeInterfaceContract = {
  nodeType: "markdown",
  label: "Markdown",
  description:
    "Rich markdown content that can be connected as context to Leader nodes.",
  ports: [CONTEXT_OUT_PORT],
};

registerContract(MARKDOWN_CONTRACT);

const COLLAPSED_HEIGHT = 38;

// ── Save helpers ──────────────────────────────────────────

function contentHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

// ── Folder picker sub-component ───────────────────────────

interface FolderPickerProps {
  projectPath: string;
  currentFolder: string;
  onSelect: (folder: string) => void;
  onClose: () => void;
}

function FolderPicker({ projectPath, currentFolder, onSelect, onClose }: FolderPickerProps) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [browsePath, setBrowsePath] = useState(currentFolder || ".");
  const [projectRoot, setProjectRoot] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDirs = useCallback(
    async (subPath: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ projectPath, subPath });
        const token = await getAuthToken();
        const res = await fetch(`/api/files/list-dirs?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          dirs: string[];
          currentPath: string;
          projectRoot: string;
        };
        setDirs(data.dirs);
        setBrowsePath(data.currentPath);
        setProjectRoot(data.projectRoot);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [projectPath],
  );

  useEffect(() => {
    void fetchDirs(browsePath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateUp = () => {
    if (browsePath === ".") return;
    const parent = browsePath.includes("/")
      ? browsePath.slice(0, browsePath.lastIndexOf("/"))
      : ".";
    void fetchDirs(parent);
  };

  const navigateInto = (dir: string) => {
    const next = browsePath === "." ? dir : `${browsePath}/${dir}`;
    void fetchDirs(next);
  };

  const breadcrumbs = browsePath === "." ? [projectRoot] : [projectRoot, ...browsePath.split("/")];

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="md-folder-picker"
    >
      <div className="md-folder-picker-header">
        <span className="md-folder-picker-title">Choose folder</span>
        <button onClick={onClose} className="md-close-btn">×</button>
      </div>

      <div className="md-folder-breadcrumbs">
        {breadcrumbs.map((crumb, i) => (
          <span key={i}>
            {i > 0 && <span style={{ margin: "0 2px", opacity: 0.4 }}>/</span>}
            <span style={{ color: i === breadcrumbs.length - 1 ? "var(--text-primary)" : "var(--text-muted)" }}>
              {crumb}
            </span>
          </span>
        ))}
      </div>

      <div className="md-folder-list">
        {loading && (
          <div className="md-folder-empty">Loading…</div>
        )}
        {error && (
          <div className="md-folder-error">{error}</div>
        )}
        {!loading && !error && (
          <>
            {browsePath !== "." && (
              <button onClick={navigateUp} className="md-folder-item">
                <span style={{ fontSize: 10, opacity: 0.5 }}>↑</span>
                ..
              </button>
            )}
            {dirs.map((dir) => (
              <button key={dir} onClick={() => navigateInto(dir)} className="md-folder-item">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="var(--accent)" style={{ flexShrink: 0, opacity: 0.6 }}>
                  <path d="M1 3h5l2 2h7v9H1V3z" />
                </svg>
                {dir}
              </button>
            ))}
            {dirs.length === 0 && browsePath !== "." && (
              <div className="md-folder-empty" style={{ fontStyle: "italic" }}>
                No subdirectories
              </div>
            )}
          </>
        )}
      </div>

      <div className="md-folder-actions">
        <span className="md-folder-path-preview">
          {browsePath === "." ? "/" : `/${browsePath}/`}
        </span>
        <button onClick={() => onSelect(browsePath)} className="md-folder-select-btn">
          Select
        </button>
      </div>
    </div>
  );
}

// ── Save dialog ───────────────────────────────────────────

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface SaveDialogProps {
  projectPath: string;
  title: string;
  content: string;
  savedPath: string | null;
  onSaved: (relativePath: string, hash: string) => void;
  onClose: () => void;
}

function SaveDialog({ projectPath, title, content, savedPath, onSaved, onClose }: SaveDialogProps) {
  const initial = savedPath
    ? { folder: savedPath.includes("/") ? savedPath.slice(0, savedPath.lastIndexOf("/")) : ".", filename: savedPath.slice(savedPath.lastIndexOf("/") + 1) }
    : { folder: ".", filename: `${slugify(title)}.md` };

  const [folder, setFolder] = useState(initial.folder);
  const [filename, setFilename] = useState(initial.filename);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleSave = async () => {
    const name = filename.trim() || `${slugify(title)}.md`;
    const finalName = name.endsWith(".md") ? name : `${name}.md`;
    const filePath = folder === "." ? finalName : `${folder}/${finalName}`;

    setStatus("saving");
    setErrorMsg(null);

    try {
      const token = await getAuthToken();
      const res = await fetch("/api/files/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath, filePath, content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as { relativePath: string };
      setStatus("saved");
      onSaved(result.relativePath, contentHash(content));
      setTimeout(onClose, 600);
    } catch (err: unknown) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const displayFolder = folder === "." ? "/" : `/${folder}/`;

  return (
    <div onMouseDown={(e) => e.stopPropagation()} className="md-save-dialog">
      <div className="md-save-dialog-header">
        <span className="md-save-dialog-title">Save to Project</span>
        <button onClick={onClose} className="md-close-btn">×</button>
      </div>

      {/* Folder row */}
      <div style={{ position: "relative" }}>
        <label className="md-save-label">Folder</label>
        <button
          onClick={() => setShowFolderPicker(!showFolderPicker)}
          className="md-save-folder-btn"
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayFolder}
          </span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="var(--text-muted)" style={{ flexShrink: 0, marginLeft: 4, transform: showFolderPicker ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <path d="M2 3 L5 7 L8 3Z" />
          </svg>
        </button>
        {showFolderPicker && (
          <FolderPicker
            projectPath={projectPath}
            currentFolder={folder}
            onSelect={(f) => {
              setFolder(f);
              setShowFolderPicker(false);
            }}
            onClose={() => setShowFolderPicker(false)}
          />
        )}
      </div>

      {/* Filename row */}
      <div>
        <label className="md-save-label">Filename</label>
        <input
          ref={inputRef}
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
            if (e.key === "Escape") onClose();
          }}
          className="md-save-input"
          placeholder="filename.md"
        />
      </div>

      {/* Preview path */}
      <div className="md-save-path-preview">
        {folder === "." ? "" : `${folder}/`}{filename.trim() || `${slugify(title)}.md`}
      </div>

      {errorMsg && <div className="md-save-error">{errorMsg}</div>}

      <div className="md-save-actions">
        <button onClick={onClose} className="md-save-cancel-btn">Cancel</button>
        <button
          onClick={() => void handleSave()}
          disabled={status === "saving"}
          className="md-save-confirm-btn"
          data-status={status}
        >
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────

export function MarkdownNodeRenderer({
  node,
  onUpdateData,
  onResize,
  onResizeStart,
  onResizeEnd,
  projectPath,
  onCreateKanbanCardFromMarkdown,
}: NodeRenderProps) {
  const data = node.data as MarkdownData;
  const collapsed = data.collapsed ?? false;
  const cardTitleInputRef = useRef<HTMLInputElement>(null);
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showCardPrompt, setShowCardPrompt] = useState(false);
  const [cardTitleDraft, setCardTitleDraft] = useState("");
  const [cardSaved, setCardSaved] = useState(false);
  const [lineCount, setLineCount] = useState(1);

  const update = (patch: Partial<MarkdownData>) =>
    onUpdateData({ ...data, ...patch });

  const currentHash = contentHash(data.content);
  const hasUnsavedChanges = data.savedPath
    ? currentHash !== data.savedContentHash
    : false;

  const handleQuickSave = async () => {
    if (!data.savedPath || !projectPath) return;
    try {
      const token = await getAuthToken();
      const res = await fetch("/api/files/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          projectPath,
          filePath: data.savedPath,
          content: data.content,
        }),
      });
      if (res.ok) {
        update({ savedContentHash: contentHash(data.content) });
      }
    } catch {
      setShowSaveDialog(true);
    }
  };

  const openCardPrompt = () => {
    if (!onCreateKanbanCardFromMarkdown) return;
    setCardTitleDraft(data.title.trim());
    setShowSaveDialog(false);
    setShowCardPrompt(true);
  };

  const handleSaveAsKanbanCard = () => {
    if (!onCreateKanbanCardFromMarkdown) return;
    const trimmedTitle = cardTitleDraft.trim();
    if (!trimmedTitle) return;
    onCreateKanbanCardFromMarkdown({
      nodeId: node.id,
      title: trimmedTitle,
      content: data.content,
    });
    setShowCardPrompt(false);
    setCardSaved(true);
    window.setTimeout(() => setCardSaved(false), 1800);
  };

  const toggleCollapse = () => {
    if (!collapsed) {
      update({ collapsed: true, expandedHeight: node.size.height });
      onResize?.({ width: node.size.width, height: COLLAPSED_HEIGHT });
    } else {
      const restoreHeight = data.expandedHeight ?? 360;
      update({ collapsed: false });
      onResize?.({ width: node.size.width, height: restoreHeight });
    }
  };

  useEffect(() => {
    const words = data.content.trim().split(/\s+/).filter(Boolean).length;
    setWordCount(words);
    setLineCount(data.content.split("\n").length);
  }, [data.content]);

  // Focus into the editor is handled inside MarkdownEditor on mount.
  // The editor mounts/unmounts based on `viewMode`, so switching from
  // Read → Write naturally gives it focus.

  useEffect(() => {
    if (showCardPrompt) {
      cardTitleInputRef.current?.focus();
      cardTitleInputRef.current?.select();
    }
  }, [showCardPrompt]);

  // Cmd+S handler — delegated from CodeMirror's keymap into the existing
  // save flow (quick-save if we already know a path, otherwise open the
  // save-as dialog).
  const handleEditorSave = useCallback(() => {
    if (data.savedPath && projectPath && hasUnsavedChanges) {
      void handleQuickSave();
    } else if (projectPath) {
      setShowSaveDialog(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.savedPath, projectPath, hasUnsavedChanges]);

  // ── Focus mode (fullscreen overlay) ────────────────────
  // Ephemeral, per-instance, per-session — modern markdown editors
  // (Typora, iA Writer, HackMD, StackEdit) treat focus mode as a
  // transient presentation state rather than something to persist.
  // We intentionally do NOT store this on `data` for that reason.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((v) => !v);
  }, []);

  // Window-level keyboard: Cmd/Ctrl+Shift+F toggles, Esc exits.
  // Window-level — not editor-level — so it works regardless of which
  // surface within the node is focused (title input, save dialog, etc.).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+Shift+F → toggle.  Only fires for this node when its
      // editor or any child is focused, or when *no* card is in
      // fullscreen (so a global hotkey from anywhere enters this card's
      // fullscreen if the node owns the focus path).
      if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        const root = nodeRootRef.current;
        const focused = document.activeElement;
        const owns = root && (root === focused || root.contains(focused));
        if (owns) {
          e.preventDefault();
          toggleFullscreen();
        }
        return;
      }
      // Esc exits fullscreen (only if we are the one in fullscreen).
      if (e.key === "Escape" && isFullscreen) {
        e.preventDefault();
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen, toggleFullscreen]);

  // Lock body scroll while the overlay is up. Without this, a stray
  // wheel/trackpad event near the edge of the overlay can scroll the
  // page or pan the canvas underneath.
  useEffect(() => {
    if (!isFullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isFullscreen]);

  // Ref used by the keyboard handler to scope Cmd+Shift+F to the focused
  // node. Assigned to the in-canvas wrapper (NOT the portaled overlay)
  // so both views identify as "this card".
  const nodeRootRef = useRef<HTMLDivElement | null>(null);

  // ── Resizable Split divider ────────────────────────────
  //
  // The Split mode divider is draggable. Strategy:
  //   - During drag, we track a `draftRatio` in *component* state and
  //     write it into a CSS variable on the writing-area host. The
  //     editor and preview pick up the variable via `flex` so resize
  //     is a pure CSS operation — no React re-render per pointer move.
  //   - On pointer up we commit the final ratio into `data.splitRatio`
  //     so it persists across reloads.
  //   - `setPointerCapture` keeps the drag live even if the cursor
  //     drifts outside the divider (a common ergonomic improvement
  //     over plain `mousemove` listeners).
  const writingAreaRef = useRef<HTMLDivElement | null>(null);
  const dragRatioRef = useRef<number | null>(null);
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);

  const persistedSplitRatio = clampSplit(data.splitRatio ?? SPLIT_DEFAULT);

  // The drag is driven entirely off `dragRatioRef`. Storing "am I
  // dragging?" in a ref (rather than only in state) means the move/up
  // handlers are immune to the stale-closure problem you'd get if
  // they only consulted `isDraggingDivider`. The state mirror exists
  // solely so the divider can render a visual `data-dragging` flag.
  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!writingAreaRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture is unimplemented in some test environments.
    }
    dragRatioRef.current = persistedSplitRatio;
    setIsDraggingDivider(true);
  };

  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRatioRef.current === null || !writingAreaRef.current) return;
    const rect = writingAreaRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const next = clampSplit((e.clientX - rect.left) / rect.width);
    dragRatioRef.current = next;
    // Write directly to the CSS variable — bypasses React for the
    // duration of the drag so the layout updates at the browser's
    // refresh rate, not React's commit rate.
    writingAreaRef.current.style.setProperty("--md-split-ratio", String(next));
  };

  const endDividerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRatioRef.current === null) return;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      // pointerId may already be released — safe to ignore.
    }
    const final = dragRatioRef.current;
    dragRatioRef.current = null;
    setIsDraggingDivider(false);
    if (final !== null && final !== persistedSplitRatio) {
      update({ splitRatio: final });
    }
  };

  const onDividerDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    update({ splitRatio: SPLIT_DEFAULT });
    if (writingAreaRef.current) {
      writingAreaRef.current.style.setProperty(
        "--md-split-ratio",
        String(SPLIT_DEFAULT),
      );
    }
  };

  const isEdit = data.viewMode === "edit";
  const isSplit = data.viewMode === "split";
  const showEditor = isEdit || isSplit;
  const showPreview = !isEdit; // both "preview" and "split"

  const nodeContent = (
    <div
      className="md-node"
      data-collapsed={collapsed}
      data-fullscreen={isFullscreen}
      data-mode={data.viewMode}
      ref={nodeRootRef}
    >
      {/* ── Inline styles (scoped to this node via class names) ── */}
      <style>{`
        .md-node {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--bg-secondary);
          border-radius: 6px;
          border: 1px solid var(--border-default);
          box-shadow: var(--shadow-sm);
          overflow: hidden;
          position: relative;
          font-family: var(--font-sans);
        }

        /* ── Title bar ─────────────────── */
        /* The header doubles as the node's drag handle. Interactive
           children inside it (the title input, the mode pills, the
           fullscreen button) opt out of drag at the CanvasNode level
           because they are input/button elements — so the visible
           drag area is whatever header background and dedicated
           grip/spacer regions remain. cursor:move advertises that. */
        .md-header {
          padding: 6px 10px;
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--bg-surface);
          border-bottom: 1px solid var(--border-default);
          flex-shrink: 0;
          min-height: 36px;
          cursor: move;
        }
        .md-node[data-collapsed="true"] .md-header {
          border-bottom: none;
        }

        /* Dedicated drag grip at the leading edge of the header — the
           obvious "grab here" affordance. Inherits move cursor from
           the header but brightens on hover to signal interactivity. */
        .md-drag-grip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 22px;
          color: var(--text-muted);
          opacity: 0.55;
          flex-shrink: 0;
          border-radius: 3px;
          cursor: grab;
          transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
        }
        .md-drag-grip:hover {
          opacity: 1;
          color: var(--text-secondary);
          background: var(--state-hover);
        }
        .md-drag-grip:active {
          cursor: grabbing;
        }

        /* Always-present flex spacer between the title and the mode
           toggle. Even with a long title (which would otherwise consume
           the header), this gives the user a guaranteed drag region. */
        .md-header-spacer {
          flex: 1 1 12px;
          min-width: 12px;
          align-self: stretch;
          cursor: move;
        }

        .md-collapse-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 0 2px;
          display: flex;
          align-items: center;
          color: var(--text-muted);
          font-size: 12px;
          line-height: 1;
          transition: transform 0.2s ease, color 0.15s;
          flex-shrink: 0;
        }
        .md-collapse-btn:hover {
          color: var(--text-secondary);
        }

        .md-title-input {
          /* Bounded width so the .md-header-spacer beside it always
             has room to absorb leftover header width and stay
             draggable. Long titles scroll within the input rather than
             eating the whole header. */
          flex: 1 1 auto;
          background: transparent;
          border: none;
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 600;
          font-family: var(--font-sans);
          outline: none;
          padding: 1px 4px;
          min-width: 40px;
          max-width: 240px;
          border-radius: 3px;
          transition: background 0.15s;
        }
        .md-title-input:focus {
          background: var(--state-hover);
        }
        .md-title-input::placeholder {
          color: var(--text-muted);
        }

        /* ── Mode toggle ──────────────── */
        .md-mode-toggle {
          display: flex;
          gap: 0;
          flex-shrink: 0;
          background: var(--bg-primary);
          border-radius: 5px;
          padding: 1px;
        }
        .md-mode-btn {
          background: transparent;
          border: none;
          border-radius: 4px;
          color: var(--text-muted);
          font-size: 10px;
          font-family: var(--font-sans);
          font-weight: 500;
          padding: 2px 10px;
          cursor: pointer;
          transition: all 0.15s ease;
          letter-spacing: 0.02em;
        }
        .md-mode-btn:hover {
          color: var(--text-secondary);
        }
        .md-mode-btn[data-active="true"] {
          background: var(--bg-elevated);
          color: var(--text-primary);
          box-shadow: var(--shadow-sm);
        }

        /* ── Writing surface ──────────── */
        /* CodeMirror host container. The editor's own theme (in
           MarkdownEditor.tsx) supplies the font, caret, selection,
           and placeholder styles; we only set layout here. */
        .md-editor-host {
          flex: 1 1 0;
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          background: var(--bg-primary);
        }
        .md-editor-host > .cm-editor {
          flex: 1;
          height: 100%;
        }
        /* In Split mode, the editor and preview share the row using
           the --md-split-ratio CSS variable (0..1, editor's share).
           flex-basis: 0 lets the grow values determine proportions. */
        .md-writing-area[data-mode="split"] .md-editor-host {
          flex: calc(var(--md-split-ratio, 0.5)) 1 0;
        }
        .md-writing-area[data-mode="split"] .md-preview {
          flex: calc(1 - var(--md-split-ratio, 0.5)) 1 0;
        }

        /* Resizable vertical divider between editor and preview in
           Split mode. 7px wide hit area, 1px visible line, brightens
           on hover and during drag. */
        .md-split-divider {
          flex: 0 0 7px;
          position: relative;
          cursor: col-resize;
          background: transparent;
          align-self: stretch;
          touch-action: none;
          user-select: none;
        }
        .md-split-divider::before {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: 3px;
          right: 3px;
          background: var(--border-default);
          opacity: 0.6;
          transition: opacity 0.15s ease, background 0.15s ease;
        }
        .md-split-divider:hover::before,
        .md-split-divider:focus-visible::before,
        .md-split-divider[data-dragging="true"]::before {
          background: var(--accent);
          opacity: 1;
        }
        .md-split-divider:focus-visible {
          outline: none;
        }
        /* Hide a system caret if a focus ring would appear on tab. */
        .md-split-divider:focus {
          outline: none;
        }

        /* ── Preview surface ──────────── */
        .md-preview {
          flex: 1 1 0;
          min-width: 0;
          padding: 14px 20px;
          background: var(--bg-primary);
          color: var(--text-secondary);
          font-size: 13.5px;
          font-family: var(--font-sans);
          line-height: 1.75;
          letter-spacing: 0.005em;
          overflow-y: auto;
        }
        .md-preview .md-h1 {
          margin: 20px 0 8px;
          font-size: 20px;
          font-weight: 700;
          color: var(--text-primary);
          letter-spacing: -0.01em;
          line-height: 1.3;
        }
        .md-preview .md-h2 {
          margin: 16px 0 6px;
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
          letter-spacing: -0.005em;
          line-height: 1.4;
        }
        .md-preview .md-h3 {
          margin: 14px 0 4px;
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
          line-height: 1.4;
        }
        .md-preview .md-p {
          margin: 4px 0;
          color: var(--text-secondary);
          line-height: 1.75;
        }
        .md-preview .md-list {
          margin: 6px 0;
          padding-left: 20px;
        }
        .md-preview .md-list li {
          margin: 3px 0;
          color: var(--text-secondary);
          line-height: 1.65;
        }
        .md-preview .md-list li::marker {
          color: var(--text-muted);
        }
        .md-preview .md-blockquote {
          margin: 10px 0;
          padding: 6px 14px;
          border-left: 2px solid var(--border-hover);
          color: var(--text-dim);
          font-style: italic;
        }
        .md-preview .md-hr {
          border: none;
          border-top: 1px solid var(--border-default);
          margin: 16px 0;
        }
        .md-preview .md-spacer {
          height: 10px;
        }
        .md-preview .md-code-block {
          margin: 8px 0;
          padding: 10px 14px;
          border-radius: 5px;
          background: var(--bg-secondary);
          border: 1px solid var(--border-default);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
          color: var(--text-secondary);
        }
        .md-preview .md-inline-code {
          background: var(--bg-elevated);
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 0.9em;
          color: var(--accent);
          font-family: var(--font-mono);
        }
        .md-preview .md-bold {
          font-weight: 600;
          color: var(--text-primary);
        }

        /* ── Status bar ───────────────── */
        .md-status-bar {
          padding: 4px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-top: 1px solid var(--border-default);
          background: var(--bg-surface);
          flex-shrink: 0;
          position: relative;
          gap: 8px;
        }
        .md-status-text {
          font-size: 10px;
          color: var(--text-muted);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
          white-space: nowrap;
        }
        .md-status-right {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        /* ── Save indicator ───────────── */
        .md-saved-indicator {
          font-size: 10px;
          font-family: var(--font-mono);
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          opacity: 0.8;
        }
        .md-saved-indicator[data-dirty="false"] {
          color: var(--success-color);
        }
        .md-saved-indicator[data-dirty="true"] {
          color: var(--accent);
        }

        .md-save-btn {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--accent);
          font-size: 12px;
          padding: 0 2px;
          display: flex;
          align-items: center;
          opacity: 0.8;
          transition: opacity 0.15s;
        }
        .md-save-btn:hover {
          opacity: 1;
        }

        .md-save-as-btn {
          background: var(--state-hover);
          border: 1px solid var(--border-default);
          border-radius: 3px;
          cursor: pointer;
          color: var(--text-secondary);
          font-size: 10px;
          font-family: var(--font-sans);
          font-weight: 500;
          padding: 1px 8px;
          display: flex;
          align-items: center;
          gap: 3px;
          transition: all 0.15s;
        }
        .md-save-as-btn:hover {
          background: var(--state-active);
          color: var(--text-primary);
        }

        .md-card-btn {
          background: transparent;
          border: 1px solid var(--border-default);
          border-radius: 3px;
          cursor: pointer;
          color: var(--text-muted);
          font-size: 10px;
          font-family: var(--font-sans);
          font-weight: 500;
          padding: 1px 7px;
          display: flex;
          align-items: center;
          gap: 3px;
          transition: all 0.15s;
        }
        .md-card-btn:hover {
          background: var(--state-hover);
          color: var(--text-primary);
          border-color: var(--border-hover);
        }

        .md-card-saved {
          color: var(--success-color);
          font-size: 10px;
          font-family: var(--font-mono);
          white-space: nowrap;
        }

        .md-card-prompt {
          position: absolute;
          bottom: 32px;
          left: 8px;
          right: 8px;
          background: var(--bg-surface);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          box-shadow: var(--shadow-lg);
          z-index: 90;
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .md-card-prompt__label {
          font-size: 10px;
          color: var(--text-muted);
          font-family: var(--font-sans);
        }
        .md-card-prompt__row {
          display: flex;
          gap: 6px;
        }
        .md-card-prompt__input {
          min-width: 0;
          flex: 1;
          padding: 5px 8px;
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--border-default);
          border-radius: 4px;
          color: var(--text-secondary);
          font-size: 12px;
          font-family: var(--font-sans);
          outline: none;
          box-sizing: border-box;
        }
        .md-card-prompt__input:focus {
          border-color: var(--accent);
        }
        .md-card-prompt__cancel,
        .md-card-prompt__confirm {
          padding: 5px 10px;
          border-radius: 4px;
          font-size: 11px;
          font-family: var(--font-sans);
          cursor: pointer;
        }
        .md-card-prompt__cancel {
          background: var(--state-hover);
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
        }
        .md-card-prompt__confirm {
          background: var(--accent);
          border: none;
          color: #111;
          font-weight: 600;
        }
        .md-card-prompt__confirm:disabled {
          opacity: 0.45;
          cursor: default;
        }

        .md-lang-label {
          font-size: 10px;
          color: var(--text-muted);
          font-family: var(--font-mono);
          opacity: 0.6;
        }

        /* ── Keyboard hint ────────────── */
        .md-kbd-hint {
          position: absolute;
          bottom: 8px;
          right: 20px;
          font-size: 10px;
          color: var(--text-muted);
          font-family: var(--font-mono);
          opacity: 0;
          transition: opacity 0.3s ease;
          pointer-events: none;
          display: flex;
          gap: 10px;
        }
        .md-writing-area:focus-within .md-kbd-hint {
          opacity: 0.5;
        }
        .md-kbd-hint kbd {
          display: inline-flex;
          padding: 0 4px;
          border-radius: 3px;
          background: var(--bg-elevated);
          border: 1px solid var(--border-default);
          font-family: var(--font-mono);
          font-size: 9px;
          line-height: 1.6;
        }

        /* ── Close button (shared) ────── */
        .md-close-btn {
          background: none;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
          padding: 0 2px;
          transition: color 0.15s;
        }
        .md-close-btn:hover {
          color: var(--text-secondary);
        }

        /* ── Folder picker ────────────── */
        .md-folder-picker {
          position: absolute;
          bottom: calc(100% + 4px);
          left: 0;
          right: 0;
          background: var(--bg-surface);
          border: 1px solid var(--border-default);
          border-radius: 6px;
          box-shadow: var(--shadow-lg);
          z-index: 100;
          max-height: 300px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .md-folder-picker-header {
          padding: 8px 10px 6px;
          border-bottom: 1px solid var(--border-default);
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
        }
        .md-folder-picker-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-primary);
          font-family: var(--font-sans);
        }
        .md-folder-breadcrumbs {
          padding: 4px 10px;
          font-size: 10px;
          color: var(--text-muted);
          font-family: var(--font-mono);
          border-bottom: 1px solid var(--border-default);
          display: flex;
          align-items: center;
          gap: 2px;
          flex-shrink: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .md-folder-list {
          flex: 1;
          overflow-y: auto;
          padding: 4px 0;
        }
        .md-folder-item {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 5px 10px;
          background: none;
          border: none;
          color: var(--text-secondary);
          font-size: 12px;
          font-family: var(--font-sans);
          cursor: pointer;
          text-align: left;
          transition: background 0.1s;
        }
        .md-folder-item:hover {
          background: var(--state-hover);
        }
        .md-folder-empty {
          padding: 12px 10px;
          font-size: 11px;
          color: var(--text-muted);
          font-family: var(--font-sans);
          text-align: center;
        }
        .md-folder-error {
          padding: 8px 10px;
          font-size: 11px;
          color: #e06c75;
          font-family: var(--font-sans);
        }
        .md-folder-actions {
          padding: 6px 10px;
          border-top: 1px solid var(--border-default);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          flex-shrink: 0;
        }
        .md-folder-path-preview {
          font-size: 10px;
          color: var(--text-muted);
          font-family: var(--font-mono);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        .md-folder-select-btn {
          padding: 4px 12px;
          background: var(--accent);
          border: none;
          border-radius: 4px;
          color: #111;
          font-size: 11px;
          font-weight: 600;
          font-family: var(--font-sans);
          cursor: pointer;
          flex-shrink: 0;
        }

        /* ── Save dialog ──────────────── */
        .md-save-dialog {
          position: absolute;
          bottom: 32px;
          left: 8px;
          right: 8px;
          background: var(--bg-surface);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          box-shadow: var(--shadow-lg);
          z-index: 90;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .md-save-dialog-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .md-save-dialog-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          font-family: var(--font-sans);
        }
        .md-save-label {
          font-size: 10px;
          color: var(--text-muted);
          font-family: var(--font-sans);
          margin-bottom: 2px;
          display: block;
        }
        .md-save-folder-btn {
          width: 100%;
          padding: 5px 8px;
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--border-default);
          border-radius: 4px;
          color: var(--text-secondary);
          font-size: 12px;
          font-family: var(--font-mono);
          cursor: pointer;
          text-align: left;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: border-color 0.15s;
        }
        .md-save-folder-btn:hover {
          border-color: var(--border-hover);
        }
        .md-save-input {
          width: 100%;
          padding: 5px 8px;
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--border-default);
          border-radius: 4px;
          color: var(--text-secondary);
          font-size: 12px;
          font-family: var(--font-mono);
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.15s;
        }
        .md-save-input:focus {
          border-color: var(--accent);
        }
        .md-save-path-preview {
          font-size: 10px;
          color: var(--text-muted);
          font-family: var(--font-mono);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .md-save-error {
          font-size: 11px;
          color: #e06c75;
          font-family: var(--font-sans);
        }
        .md-save-actions {
          display: flex;
          gap: 6px;
          justify-content: flex-end;
        }
        .md-save-cancel-btn {
          padding: 5px 12px;
          background: var(--state-hover);
          border: 1px solid var(--border-default);
          border-radius: 4px;
          color: var(--text-secondary);
          font-size: 11px;
          font-family: var(--font-sans);
          cursor: pointer;
          transition: all 0.15s;
        }
        .md-save-cancel-btn:hover {
          background: var(--state-active);
        }
        .md-save-confirm-btn {
          padding: 5px 14px;
          background: var(--accent);
          border: none;
          border-radius: 4px;
          color: #111;
          font-size: 11px;
          font-weight: 600;
          font-family: var(--font-sans);
          cursor: pointer;
          transition: all 0.2s;
        }
        .md-save-confirm-btn:hover {
          filter: brightness(1.1);
        }
        .md-save-confirm-btn[data-status="saving"] {
          opacity: 0.7;
          cursor: wait;
        }
        .md-save-confirm-btn[data-status="saved"] {
          background: var(--success-color);
        }

        /* ── Focus mode (fullscreen overlay) ─────────────── */
        .md-fullscreen-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-muted);
          border-radius: 4px;
          cursor: pointer;
          margin-left: 4px;
          transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        }
        .md-fullscreen-btn:hover {
          background: var(--bg-elevated);
          color: var(--text-primary);
          border-color: var(--border-default);
        }
        .md-fullscreen-btn[aria-pressed="true"] {
          background: var(--bg-elevated);
          color: var(--accent);
          border-color: var(--border-default);
        }
        /* Placeholder kept in the canvas while the real UI is portaled. */
        .md-fullscreen-stub {
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
          font-style: italic;
          font-size: 12px;
          background: var(--bg-secondary);
          opacity: 0.7;
          display: flex;
        }
        .md-fullscreen-stub-label {
          padding: 8px 12px;
        }
        /* The full-viewport overlay container. */
        .md-fullscreen-overlay {
          position: fixed;
          inset: 0;
          z-index: 1000;
          display: flex;
          align-items: stretch;
          justify-content: center;
          background: var(--bg-primary);
          backdrop-filter: saturate(140%);
          animation: md-fade-in 120ms ease-out;
        }
        @keyframes md-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        /* Overrides applied to the node when it's the overlay's child. */
        .md-fullscreen-overlay > .md-node[data-fullscreen="true"] {
          width: 100%;
          height: 100%;
          max-width: none;
          border-radius: 0;
          border: none;
          box-shadow: none;
        }
        /* Slim header chrome in focus mode. */
        .md-fullscreen-overlay .md-node[data-fullscreen="true"] .md-header {
          padding: 8px 18px;
          min-height: 44px;
        }
        /* Centered reading column for single-pane modes. Generous
           typography for the typewriter feel of modern focus modes.
           Split mode stays edge-to-edge so both panes get the room. */
        .md-node[data-fullscreen="true"][data-mode="edit"] .md-writing-area,
        .md-node[data-fullscreen="true"][data-mode="preview"] .md-writing-area {
          padding: 24px clamp(16px, 6vw, 80px);
        }
        .md-node[data-fullscreen="true"][data-mode="edit"] .md-editor-host,
        .md-node[data-fullscreen="true"][data-mode="preview"] .md-preview {
          max-width: 820px;
          margin: 0 auto;
          width: 100%;
        }
        .md-node[data-fullscreen="true"][data-mode="edit"] .md-editor-host .cm-scroller,
        .md-node[data-fullscreen="true"][data-mode="preview"] .md-preview {
          font-size: 15px;
          line-height: 1.8;
        }
        .md-node[data-fullscreen="true"][data-mode="split"] .md-writing-area {
          padding: 18px;
        }
        /* Footer chrome stays put but with calmer padding. */
        .md-node[data-fullscreen="true"] .md-status-bar {
          padding: 8px 18px;
        }
      `}</style>

      {/* ── Title bar ─────────────────────────────────── */}
      <div className="md-header">
        {/* Leading drag grip — the obvious "grab to move" affordance.
            Plain span (not a button) so the CanvasNode drag handler
            sees it as non-interactive and initiates a node drag on
            mousedown. `aria-hidden` keeps it out of the a11y tree;
            the `title` is a sighted-user hint and the surface used by
            the regression test in MarkdownNode.test.tsx. */}
        <span
          className="md-drag-grip"
          title="Drag to move"
          aria-hidden="true"
        >
          <svg
            width="8"
            height="14"
            viewBox="0 0 8 14"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="2" cy="3" r="1" />
            <circle cx="6" cy="3" r="1" />
            <circle cx="2" cy="7" r="1" />
            <circle cx="6" cy="7" r="1" />
            <circle cx="2" cy="11" r="1" />
            <circle cx="6" cy="11" r="1" />
          </svg>
        </span>

        <button
          onClick={toggleCollapse}
          onMouseDown={(e) => e.stopPropagation()}
          title={collapsed ? "Expand" : "Collapse"}
          className="md-collapse-btn"
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M2 3 L5 7 L8 3Z" />
          </svg>
        </button>

        {collapsed ? (
          <span
            className="md-title-input"
            style={{ cursor: "inherit" }}
            onPointerDown={(e) => {
              clickStartRef.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerUp={(e) => {
              if (clickStartRef.current) {
                const d =
                  Math.abs(e.clientX - clickStartRef.current.x) +
                  Math.abs(e.clientY - clickStartRef.current.y);
                clickStartRef.current = null;
                if (d < 5) toggleCollapse();
              }
            }}
          >
            {data.title || "Untitled"}
          </span>
        ) : (
          <input
            value={data.title}
            onChange={(e) => update({ title: e.target.value })}
            onMouseDown={(e) => e.stopPropagation()}
            className="md-title-input"
            placeholder="Untitled"
          />
        )}

        {/* Always-present drag region between the title and the
            mode/fullscreen buttons. With the title input capped at
            240px, this absorbs all leftover header width and keeps a
            meaningful drag target on any node size. */}
        <div className="md-header-spacer" aria-hidden="true" />

        {!collapsed && (
          <>
            <div className="md-mode-toggle">
              <button
                onClick={() => update({ viewMode: "edit" })}
                onMouseDown={(e) => e.stopPropagation()}
                className="md-mode-btn"
                data-active={isEdit}
              >
                Write
              </button>
              <button
                onClick={() => update({ viewMode: "split" })}
                onMouseDown={(e) => e.stopPropagation()}
                className="md-mode-btn"
                data-active={isSplit}
                title="Live preview alongside editor"
              >
                Split
              </button>
              <button
                onClick={() => update({ viewMode: "preview" })}
                onMouseDown={(e) => e.stopPropagation()}
                className="md-mode-btn"
                data-active={data.viewMode === "preview"}
              >
                Read
              </button>
            </div>
            <button
              onClick={toggleFullscreen}
              onMouseDown={(e) => e.stopPropagation()}
              className="md-fullscreen-btn"
              title={
                isFullscreen
                  ? "Exit focus mode (Esc)"
                  : "Focus mode (⌘⇧F)"
              }
              aria-label={isFullscreen ? "Exit focus mode" : "Enter focus mode"}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? (
                // Collapse glyph — two arrows pointing inward.
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <path d="M7 2v4H3v1.5h5.5V2H7zM2 8.5V10h4v4h1.5V8.5H2zm12.5 0H9V14h1.5v-4h4V8.5zM14.5 7v-.5H10V2H8.5v5.5h6V7z" />
                </svg>
              ) : (
                // Expand glyph — two arrows pointing outward (NW/SE).
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <path d="M2 2h5v1.5H3.5V7H2V2zm12 0v5h-1.5V3.5H9V2h5zM2 14V9h1.5v3.5H7V14H2zm12 0H9v-1.5h3.5V9H14v5z" />
                </svg>
              )}
            </button>
          </>
        )}
      </div>

      {/* ── Writing area ──────────────────────────────── */}
      {!collapsed && (
        <>
          <div
            ref={writingAreaRef}
            className="md-writing-area"
            data-mode={data.viewMode}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "row",
              position: "relative",
              overflow: "hidden",
              minHeight: 0,
              // CSS variable consumed by `.md-editor-host` and
              // `.md-preview` in Split mode to size the panes.
              ["--md-split-ratio" as never]: String(persistedSplitRatio),
            }}
          >
            {showEditor && (
              <MarkdownEditor
                value={data.content}
                onChange={(next) => update({ content: next })}
                onSave={handleEditorSave}
                placeholder="Start writing…"
                className="md-editor-host"
                ariaLabel="Markdown editor"
              />
            )}
            {isSplit && (
              <div
                className="md-split-divider"
                data-dragging={isDraggingDivider}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize editor and preview panes"
                aria-valuenow={Math.round(persistedSplitRatio * 100)}
                aria-valuemin={Math.round(SPLIT_MIN * 100)}
                aria-valuemax={Math.round(SPLIT_MAX * 100)}
                tabIndex={0}
                onPointerDown={onDividerPointerDown}
                onPointerMove={onDividerPointerMove}
                onPointerUp={endDividerDrag}
                onPointerCancel={endDividerDrag}
                onDoubleClick={onDividerDoubleClick}
                title="Drag to resize · double-click to reset"
              />
            )}
            {showPreview && (
              <MarkdownPreview
                content={data.content}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={() => update({ viewMode: "edit" })}
              />
            )}
          </div>

          {/* ── Status bar ──────────────────────────────── */}
          <div className="md-status-bar">
            <span className="md-status-text">
              {wordCount} {wordCount === 1 ? "word" : "words"} · {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>

            <div className="md-status-right">
              {data.savedPath && (
                <span
                  title={data.savedPath}
                  className="md-saved-indicator"
                  data-dirty={hasUnsavedChanges}
                >
                  {hasUnsavedChanges ? "●" : "✓"} {data.savedPath.split("/").pop()}
                </span>
              )}

              {projectPath && data.savedPath && hasUnsavedChanges && (
                <button
                  onClick={() => void handleQuickSave()}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={`Save to ${data.savedPath}`}
                  className="md-save-btn"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2 1h9l3 3v11H2V1zm2 0v5h7V1H4zm1 1h3v3H5V2zm-1 7h8v5H4v-5z" />
                  </svg>
                </button>
              )}

              {projectPath && (
                <button
                  onClick={() => {
                    setShowCardPrompt(false);
                    setShowSaveDialog(true);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={data.savedPath ? "Save As…" : "Save to project…"}
                  className="md-save-as-btn"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2 1h9l3 3v11H2V1zm2 0v5h7V1H4zm1 1h3v3H5V2zm-1 7h8v5H4v-5z" />
                  </svg>
                  {data.savedPath ? "Save As" : "Save"}
                </button>
              )}

              {onCreateKanbanCardFromMarkdown && (
                cardSaved ? (
                  <span className="md-card-saved">Card added</span>
                ) : (
                  <button
                    onClick={openCardPrompt}
                    onMouseDown={(e) => e.stopPropagation()}
                    title="Save as Kanban card"
                    className="md-card-btn"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <rect x="2" y="3" width="12" height="10" rx="1.5" />
                      <line x1="5" y1="6" x2="11" y2="6" />
                      <line x1="5" y1="9" x2="9" y2="9" />
                    </svg>
                    Card
                  </button>
                )
              )}

              <span className="md-lang-label">md</span>
            </div>

            {showCardPrompt && (
              <div className="md-card-prompt" onMouseDown={(e) => e.stopPropagation()}>
                <label className="md-card-prompt__label" htmlFor={`md-card-title-${node.id}`}>
                  Card title
                </label>
                <div className="md-card-prompt__row">
                  <input
                    id={`md-card-title-${node.id}`}
                    ref={cardTitleInputRef}
                    className="md-card-prompt__input"
                    value={cardTitleDraft}
                    onChange={(e) => setCardTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveAsKanbanCard();
                      if (e.key === "Escape") setShowCardPrompt(false);
                    }}
                    placeholder="Task title"
                  />
                  <button
                    className="md-card-prompt__cancel"
                    onClick={() => setShowCardPrompt(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="md-card-prompt__confirm"
                    onClick={handleSaveAsKanbanCard}
                    disabled={!cardTitleDraft.trim()}
                  >
                    Add
                  </button>
                </div>
              </div>
            )}

            {showSaveDialog && projectPath && (
              <SaveDialog
                projectPath={projectPath}
                title={data.title}
                content={data.content}
                savedPath={data.savedPath ?? null}
                onSaved={(relativePath, hash) => {
                  update({ savedPath: relativePath, savedContentHash: hash });
                }}
                onClose={() => setShowSaveDialog(false)}
              />
            )}
          </div>

          {onResize && !isFullscreen && (
            <ResizeHandle
              currentSize={node.size}
              minWidth={240}
              minHeight={200}
              onResize={onResize}
              {...(onResizeStart ? { onResizeStart } : {})}
              {...(onResizeEnd ? { onResizeEnd } : {})}
              color="var(--text-muted)"
            />
          )}
        </>
      )}
    </div>
  );

  // When the user is in focus mode, render the same node UI in a portal
  // attached to <body>. `position: fixed` alone is not enough to escape
  // the canvas's CSS transform stack — `transform` on an ancestor
  // creates a containing block for fixed descendants, anchoring them
  // inside the (panned/zoomed) canvas rather than the viewport. The
  // portal sidesteps the entire transform ancestry.
  if (isFullscreen) {
    return (
      <>
        {/* Lightweight placeholder kept in the canvas so the node still
            registers selection / hit-testing while its real UI is
            overlaid. */}
        <div
          className="md-node md-fullscreen-stub"
          data-fullscreen-stub
          aria-hidden
        >
          <span className="md-fullscreen-stub-label">In focus mode…</span>
        </div>
        {createPortal(
          <div
            className="md-fullscreen-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Markdown focus mode"
            data-scroll-capture
          >
            {nodeContent}
          </div>,
          document.body,
        )}
      </>
    );
  }

  return nodeContent;
}

// ── Registration ───────────────────────────────────────

registerNodeType({
  type: "markdown",
  label: "Markdown",
  defaultSize: { width: 420, height: 380 },
  render: MarkdownNodeRenderer,
  providesContext: true,
  extractContent: (data) => (data as { content?: string })?.content ?? null,
});
