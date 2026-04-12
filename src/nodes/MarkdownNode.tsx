import { useState, useRef, useEffect, useCallback } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import { getAuthToken } from "../api.ts";

interface MarkdownData {
  title: string;
  content: string;
  viewMode: "edit" | "preview";
  collapsed?: boolean;
  /** Saved height before collapsing so we can restore on expand */
  expandedHeight?: number;
  /** Last saved relative path (persisted across sessions) */
  savedPath?: string | null;
  /** Content hash at last save — used to detect unsaved changes */
  savedContentHash?: string | null;
}

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

// ── Simple markdown -> HTML ─────────────────────────────

function renderMarkdown(src: string): string {
  const escaped = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = escaped.split("\n");
  const html: string[] = [];
  let inList = false;
  let inOrderedList = false;
  let inCodeBlock = false;

  for (const line of lines) {
    // Code fences
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        html.push("</code></pre>");
        inCodeBlock = false;
      } else {
        html.push('<pre class="md-code-block"><code>');
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      html.push(line + "\n");
      continue;
    }

    // Close lists if we leave list context
    if (inList && !line.startsWith("- ")) {
      html.push("</ul>");
      inList = false;
    }
    if (inOrderedList && !/^\d+\.\s/.test(line)) {
      html.push("</ol>");
      inOrderedList = false;
    }

    if (line.startsWith("### ")) {
      html.push(`<h5 class="md-h3">${inlineFormat(line.slice(4))}</h5>`);
    } else if (line.startsWith("## ")) {
      html.push(`<h4 class="md-h2">${inlineFormat(line.slice(3))}</h4>`);
    } else if (line.startsWith("# ")) {
      html.push(`<h3 class="md-h1">${inlineFormat(line.slice(2))}</h3>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        html.push('<ul class="md-list">');
        inList = true;
      }
      html.push(`<li>${inlineFormat(line.slice(2))}</li>`);
    } else if (/^\d+\.\s/.test(line)) {
      if (!inOrderedList) {
        html.push('<ol class="md-list">');
        inOrderedList = true;
      }
      html.push(`<li>${inlineFormat(line.replace(/^\d+\.\s/, ""))}</li>`);
    } else if (line.startsWith("&gt; ")) {
      html.push(`<blockquote class="md-blockquote">${inlineFormat(line.slice(5))}</blockquote>`);
    } else if (line.startsWith("---")) {
      html.push('<hr class="md-hr">');
    } else if (line.trim() === "") {
      html.push('<div class="md-spacer"></div>');
    } else {
      html.push(`<p class="md-p">${inlineFormat(line)}</p>`);
    }
  }

  if (inList) html.push("</ul>");
  if (inOrderedList) html.push("</ol>");
  if (inCodeBlock) html.push("</code></pre>");
  return html.join("\n");
}

function inlineFormat(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="md-bold">$1</strong>')
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

/** Lightweight HTML sanitizer for our markdown output.
 * Only allows tags and attributes we explicitly generate. */
function sanitizeHtml(html: string): string {
  // Allowlist of tags we generate in renderMarkdown/inlineFormat
  const ALLOWED_TAGS = new Set([
    "h3", "h4", "h5", "p", "ul", "ol", "li", "blockquote", "hr",
    "pre", "code", "strong", "em", "div", "a",
  ]);
  const ALLOWED_CLASSES = new Set([
    "md-h1", "md-h2", "md-h3", "md-p", "md-list", "md-blockquote",
    "md-hr", "md-code-block", "md-inline-code", "md-bold", "md-spacer",
  ]);

  // Strip any tag not in our allowlist
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag) => {
    const lowerTag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(lowerTag)) return "";

    // For closing tags, pass through as-is
    if (match.startsWith("</")) return match;

    // Extract class if present
    const classMatch = match.match(/class="([^"]*)"/);
    if (classMatch) {
      const cls = classMatch[1];
      if (cls && !ALLOWED_CLASSES.has(cls)) {
        // Strip the class
        return `<${lowerTag}>`;
      }
    }

    // Strip all other attributes (href, onclick, style, etc.)
    // except class on allowed tags
    if (classMatch && ALLOWED_CLASSES.has(classMatch[1] ?? "")) {
      return `<${lowerTag} class="${classMatch[1]}">`;
    }
    return `<${lowerTag}>`;
  });
}

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

// ── Textarea keyboard helpers ────────────────────────────

function wrapSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
): string {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd);

  // If already wrapped, unwrap
  const prefixMatch =
    selectionStart >= before.length &&
    value.slice(selectionStart - before.length, selectionStart) === before;
  const suffixMatch =
    selectionEnd + after.length <= value.length &&
    value.slice(selectionEnd, selectionEnd + after.length) === after;

  if (prefixMatch && suffixMatch && selected.length > 0) {
    const newValue =
      value.slice(0, selectionStart - before.length) +
      selected +
      value.slice(selectionEnd + after.length);
    // Schedule cursor restore after React re-render
    requestAnimationFrame(() => {
      textarea.selectionStart = selectionStart - before.length;
      textarea.selectionEnd = selectionEnd - before.length;
    });
    return newValue;
  }

  const newValue =
    value.slice(0, selectionStart) +
    before +
    selected +
    after +
    value.slice(selectionEnd);

  requestAnimationFrame(() => {
    if (selected.length > 0) {
      textarea.selectionStart = selectionStart + before.length;
      textarea.selectionEnd = selectionEnd + before.length;
    } else {
      // Place cursor between markers
      textarea.selectionStart = selectionStart + before.length;
      textarea.selectionEnd = selectionStart + before.length;
    }
  });
  return newValue;
}

function handleTabIndent(
  textarea: HTMLTextAreaElement,
  shiftKey: boolean,
): string {
  const { selectionStart, selectionEnd, value } = textarea;
  const indent = "  ";

  if (shiftKey) {
    // Outdent: remove leading indent from current line
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    if (value.slice(lineStart, lineStart + indent.length) === indent) {
      const newValue =
        value.slice(0, lineStart) + value.slice(lineStart + indent.length);
      requestAnimationFrame(() => {
        textarea.selectionStart = Math.max(lineStart, selectionStart - indent.length);
        textarea.selectionEnd = Math.max(lineStart, selectionEnd - indent.length);
      });
      return newValue;
    }
    return value;
  }

  // Indent
  const newValue =
    value.slice(0, selectionStart) + indent + value.slice(selectionEnd);
  requestAnimationFrame(() => {
    textarea.selectionStart = selectionStart + indent.length;
    textarea.selectionEnd = selectionStart + indent.length;
  });
  return newValue;
}

function handleEnterKey(textarea: HTMLTextAreaElement): string | null {
  const { selectionStart, value } = textarea;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const currentLine = value.slice(lineStart, selectionStart);

  // Match leading whitespace + list marker
  const listMatch = currentLine.match(/^(\s*)([-*]\s+|\d+\.\s+)/);
  if (!listMatch) return null;

  const [, leadingSpace, marker] = listMatch;
  const contentAfterMarker = currentLine.slice(listMatch[0].length);

  // If list item is empty (just the marker), remove the marker line instead
  if (contentAfterMarker.trim() === "") {
    const newValue = value.slice(0, lineStart) + "\n" + value.slice(selectionStart);
    requestAnimationFrame(() => {
      textarea.selectionStart = lineStart + 1;
      textarea.selectionEnd = lineStart + 1;
    });
    return newValue;
  }

  // Auto-increment numbered lists
  let nextMarker = marker;
  const numMatch = marker.match(/^(\d+)\.\s+/);
  if (numMatch) {
    nextMarker = `${parseInt(numMatch[1]) + 1}. `;
  }

  const insertion = "\n" + leadingSpace + nextMarker;
  const newValue =
    value.slice(0, selectionStart) + insertion + value.slice(selectionStart);
  requestAnimationFrame(() => {
    textarea.selectionStart = selectionStart + insertion.length;
    textarea.selectionEnd = selectionStart + insertion.length;
  });
  return newValue;
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
      const res = await fetch("/api/files/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

function MarkdownNodeRenderer({ node, onUpdateData, onResize, canvasScale, projectPath }: NodeRenderProps) {
  const data = node.data as MarkdownData;
  const collapsed = data.collapsed ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
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
      const res = await fetch("/api/files/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  useEffect(() => {
    if (data.viewMode === "edit" && textareaRef.current && !collapsed) {
      textareaRef.current.focus();
    }
  }, [data.viewMode, collapsed]);

  // ── Keyboard handler for textarea ──────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd+B → bold
      if (isMod && e.key === "b") {
        e.preventDefault();
        const newValue = wrapSelection(textarea, "**", "**");
        update({ content: newValue });
        return;
      }

      // Cmd+I → italic
      if (isMod && e.key === "i") {
        e.preventDefault();
        const newValue = wrapSelection(textarea, "*", "*");
        update({ content: newValue });
        return;
      }

      // Cmd+E → inline code
      if (isMod && e.key === "e") {
        e.preventDefault();
        const newValue = wrapSelection(textarea, "`", "`");
        update({ content: newValue });
        return;
      }

      // Cmd+S → save
      if (isMod && e.key === "s") {
        e.preventDefault();
        if (data.savedPath && projectPath && hasUnsavedChanges) {
          void handleQuickSave();
        } else if (projectPath) {
          setShowSaveDialog(true);
        }
        return;
      }

      // Tab → indent/outdent
      if (e.key === "Tab") {
        e.preventDefault();
        const newValue = handleTabIndent(textarea, e.shiftKey);
        update({ content: newValue });
        return;
      }

      // Enter → auto-continue lists
      if (e.key === "Enter" && !e.shiftKey) {
        const result = handleEnterKey(textarea);
        if (result !== null) {
          e.preventDefault();
          update({ content: result });
        }
        return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.content, data.savedPath, projectPath, hasUnsavedChanges],
  );

  const isEdit = data.viewMode === "edit";

  return (
    <div className="md-node" data-collapsed={collapsed}>
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
        .md-header {
          padding: 6px 10px;
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--bg-surface);
          border-bottom: 1px solid var(--border-default);
          flex-shrink: 0;
          min-height: 36px;
        }
        .md-node[data-collapsed="true"] .md-header {
          border-bottom: none;
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
          flex: 1;
          background: transparent;
          border: none;
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 600;
          font-family: var(--font-sans);
          outline: none;
          padding: 1px 4px;
          min-width: 0;
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
        .md-textarea {
          flex: 1;
          padding: 14px 20px;
          background: var(--bg-primary);
          border: none;
          color: var(--text-primary);
          font-size: 13.5px;
          font-family: var(--font-sans);
          resize: none;
          outline: none;
          line-height: 1.75;
          letter-spacing: 0.005em;
          caret-color: var(--accent);
          tab-size: 2;
        }
        .md-textarea::placeholder {
          color: var(--text-muted);
          font-style: italic;
        }
        .md-textarea::selection {
          background: rgba(240, 136, 62, 0.25);
        }

        /* ── Preview surface ──────────── */
        .md-preview {
          flex: 1;
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
        .md-textarea:focus ~ .md-kbd-hint {
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
      `}</style>

      {/* ── Title bar ─────────────────────────────────── */}
      <div className="md-header">
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

        {!collapsed && (
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
              onClick={() => update({ viewMode: "preview" })}
              onMouseDown={(e) => e.stopPropagation()}
              className="md-mode-btn"
              data-active={!isEdit}
            >
              Read
            </button>
          </div>
        )}
      </div>

      {/* ── Writing area ──────────────────────────────── */}
      {!collapsed && (
        <>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
            {isEdit ? (
              <textarea
                ref={textareaRef}
                value={data.content}
                onChange={(e) => update({ content: e.target.value })}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={handleKeyDown}
                placeholder="Start writing…"
                spellCheck
                className="md-textarea"
                data-no-drag
              />
            ) : (
              <div
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={() => update({ viewMode: "edit" })}
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(data.content)) }}
                className="md-preview"
                data-no-drag
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
                  onClick={() => setShowSaveDialog(true)}
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

              <span className="md-lang-label">md</span>
            </div>

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

          {onResize && (
            <ResizeHandle
              currentSize={node.size}
              minWidth={240}
              minHeight={200}
              onResize={onResize}
              color="var(--text-muted)"
              canvasScale={canvasScale}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Registration ───────────────────────────────────────

registerNodeType({
  type: "markdown",
  label: "Markdown",
  defaultSize: { width: 420, height: 380 },
  render: MarkdownNodeRenderer,
});
