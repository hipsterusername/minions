import { useState, useEffect, useCallback } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, CONTEXT_OUT_PORT } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import { getAuthToken } from "../api.ts";

// ── Graph contract ─────────────────────────────────────

const FOLDER_CONTRACT: NodeInterfaceContract = {
  nodeType: "folder",
  label: "Folder",
  description:
    "Displays a project folder's contents. Can be connected as context to Leader nodes.",
  ports: [CONTEXT_OUT_PORT],
};

registerContract(FOLDER_CONTRACT);

// ── Types ──────────────────────────────────────────────

export interface FolderData {
  /** Relative folder path from project root */
  folderPath: string;
  /** Whether the listing is collapsed */
  collapsed?: boolean;
  /** Remembered expanded height */
  expandedHeight?: number;
  /** Cached listing for context system */
  loadedContent?: string;
}

interface DirEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
}

// ── Helpers ────────────────────────────────────────────

const COLLAPSED_HEIGHT = 42;
const DEFAULT_EXPANDED_HEIGHT = 360;

function encodePath(p: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(p), (b) =>
      String.fromCodePoint(b),
    ).join(""),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Map file extensions to terse type labels */
function fileTag(name: string): { label: string; color: string } {
  const ext = extOf(name);
  const map: Record<string, { label: string; color: string }> = {
    ts: { label: "TS", color: "#3178c6" },
    tsx: { label: "TSX", color: "#3178c6" },
    js: { label: "JS", color: "#f0db4f" },
    jsx: { label: "JSX", color: "#f0db4f" },
    json: { label: "JSON", color: "#7b82a0" },
    md: { label: "MD", color: "#83b7e8" },
    mdx: { label: "MDX", color: "#83b7e8" },
    css: { label: "CSS", color: "#264de4" },
    scss: { label: "SCSS", color: "#cd6799" },
    html: { label: "HTML", color: "#e34c26" },
    py: { label: "PY", color: "#3776ab" },
    rs: { label: "RS", color: "#dea584" },
    go: { label: "GO", color: "#00add8" },
    yaml: { label: "YML", color: "#cb171e" },
    yml: { label: "YML", color: "#cb171e" },
    toml: { label: "TOML", color: "#9c4121" },
    sh: { label: "SH", color: "#4eaa25" },
    sql: { label: "SQL", color: "#e38c00" },
    svg: { label: "SVG", color: "#ffb13b" },
    png: { label: "IMG", color: "#a259ff" },
    jpg: { label: "IMG", color: "#a259ff" },
    jpeg: { label: "IMG", color: "#a259ff" },
    gif: { label: "IMG", color: "#a259ff" },
    webp: { label: "IMG", color: "#a259ff" },
    txt: { label: "TXT", color: "#7b82a0" },
    env: { label: "ENV", color: "#ecd53f" },
    lock: { label: "LOCK", color: "#555" },
  };
  return map[ext] ?? { label: ext.toUpperCase().slice(0, 4) || "FILE", color: "#7b82a0" };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function folderName(path: string): string {
  const parts = path.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function parentPath(path: string): string {
  const parts = path.replace(/\/$/, "").split("/");
  return parts.slice(0, -1).join("/") || ".";
}

// ── Component ─────────────────────────────────────────

function FolderNodeRenderer({
  node,
  projectPath,
  onResize,
  onUpdateData,
}: NodeRenderProps) {
  const data = node.data as FolderData;
  const collapsed = data.collapsed === true;
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const encoded = projectPath ? encodePath(projectPath) : null;
  const name = folderName(data.folderPath);
  const parent = parentPath(data.folderPath);

  const dirCount = entries.filter((e) => e.type === "dir").length;
  const fileCount = entries.filter((e) => e.type === "file").length;

  const toggleCollapsed = useCallback(() => {
    if (collapsed) {
      const h = data.expandedHeight ?? DEFAULT_EXPANDED_HEIGHT;
      onUpdateData({ ...data, collapsed: false });
      onResize?.({ width: node.size.width, height: h });
    } else {
      onUpdateData({ ...data, collapsed: true, expandedHeight: node.size.height });
      onResize?.({ width: node.size.width, height: COLLAPSED_HEIGHT });
    }
  }, [collapsed, data, node.size, onUpdateData, onResize]);

  // Fetch directory listing for this folder. We hit /ls directly with
  // the relative path so we get immediate children regardless of depth —
  // the previous tree-based approach failed for nested paths and a second
  // "deeper fetch" effect that listed `loading` in its deps cancelled
  // itself, leaving the UI stuck on "Scanning…" forever.
  useEffect(() => {
    if (!encoded || !data.folderPath) {
      setEntries([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const relPath = data.folderPath === "." ? "" : data.folderPath;

    getAuthToken()
      .then((token) =>
        fetch(
          `/api/projects/${encoded}/ls?path=${encodeURIComponent(relPath)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{
          path: string;
          entries: DirEntry[];
        }>;
      })
      .then((json) => {
        if (cancelled) return;
        const result = json.entries ?? [];
        setEntries(result);

        // Build context string so connected leader nodes can consume the
        // listing via the registered extractContent.
        const localDirCount = result.filter((e) => e.type === "dir").length;
        const localFileCount = result.filter((e) => e.type === "file").length;
        const listing = result
          .map((e) => `${e.type === "dir" ? "📁" : "  "} ${e.name}`)
          .join("\n");
        const contextStr = `Folder: ${data.folderPath}\n${localDirCount} directories, ${localFileCount} files\n\n${listing}`;
        onUpdateData({ ...data, loadedContent: contextStr });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load");
        setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `data` and `onUpdateData` are intentionally omitted: re-running this
    // effect on every parent re-render (which produces a new `data`
    // reference after onUpdateData) would loop forever. The folder path
    // and project encoding are the only inputs that should refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoded, data.folderPath]);

  // ── Collapsed view ────────────────────────────────────

  if (collapsed) {
    return (
      <div style={containerStyle}>
        <div
          onClick={toggleCollapsed}
          onMouseDown={(e) => e.stopPropagation()}
          style={collapsedHeaderStyle}
        >
          <span style={chevronStyle}>&#9654;</span>
          <span style={folderIconCollapsedStyle}>&#128193;</span>
          <span style={collapsedNameStyle} title={data.folderPath}>
            {name || "Untitled folder"}
          </span>
          <span style={collapsedCountStyle}>
            {entries.length > 0
              ? `${dirCount}d ${fileCount}f`
              : loading
                ? "…"
                : ""}
          </span>
        </div>
      </div>
    );
  }

  // ── Expanded view ────────────────────────────────────

  const dirs = entries.filter((e) => e.type === "dir");
  const files = entries.filter((e) => e.type === "file");

  return (
    <div style={containerStyle}>
      {/* ── Header ── */}
      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <span
            onClick={toggleCollapsed}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              ...chevronStyle,
              transform: "rotate(90deg)",
              cursor: "pointer",
              padding: "2px 4px",
            }}
          >
            &#9654;
          </span>
          <span style={folderIconStyle}>&#128193;</span>
          <span style={headerNameStyle}>{name}</span>
        </div>
        <span style={headerMetaStyle}>
          {dirCount > 0 && (
            <span style={statPillStyle}>
              <span style={{ opacity: 0.5 }}>&#128194;</span> {dirCount}
            </span>
          )}
          {fileCount > 0 && (
            <span style={statPillStyle}>
              <span style={{ opacity: 0.5 }}>&#128196;</span> {fileCount}
            </span>
          )}
        </span>
      </div>

      {/* ── Breadcrumb path ── */}
      <div style={pathBarStyle} title={data.folderPath}>
        <span style={{ opacity: 0.4 }}>{parent !== "." ? parent + "/" : ""}</span>
        <span style={{ color: "var(--text-primary)" }}>{name}</span>
      </div>

      {/* ── Listing ── */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        style={listingContainerStyle}
      >
        {loading ? (
          <div style={statusStyle}>Scanning…</div>
        ) : error ? (
          <div style={{ ...statusStyle, color: "var(--danger-color, #f87171)" }}>{error}</div>
        ) : entries.length === 0 ? (
          <div style={statusStyle}>Empty directory</div>
        ) : (
          <>
            {/* Directories first */}
            {dirs.map((entry) => (
              <div key={`d-${entry.name}`} style={entryRowStyle}>
                <span style={dirIndicatorStyle} />
                <span style={entryNameStyle}>{entry.name}</span>
                <span style={entryTagStyle}>DIR</span>
              </div>
            ))}

            {/* Separator if we have both */}
            {dirs.length > 0 && files.length > 0 && (
              <div style={separatorStyle} />
            )}

            {/* Files */}
            {files.map((entry) => {
              const tag = fileTag(entry.name);
              return (
                <div key={`f-${entry.name}`} style={entryRowStyle}>
                  <span
                    style={{
                      ...fileIndicatorStyle,
                      background: tag.color,
                    }}
                  />
                  <span style={entryNameStyle}>{entry.name}</span>
                  <span
                    style={{
                      ...fileTagStyle,
                      color: tag.color,
                      borderColor: `color-mix(in srgb, ${tag.color} 30%, transparent)`,
                    }}
                  >
                    {tag.label}
                  </span>
                  {entry.size != null && (
                    <span style={fileSizeStyle}>{formatSize(entry.size)}</span>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* ── Footer summary ── */}
      {entries.length > 0 && !loading && (
        <div style={footerStyle}>
          {entries.length} item{entries.length !== 1 ? "s" : ""}
          {dirCount > 0 && ` · ${dirCount} folder${dirCount !== 1 ? "s" : ""}`}
          {fileCount > 0 && ` · ${fileCount} file${fileCount !== 1 ? "s" : ""}`}
        </div>
      )}

      {/* Resize handle */}
      {onResize && (
        <ResizeHandle
          currentSize={node.size}
          minWidth={240}
          minHeight={160}
          onResize={onResize}
        />
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────
// Using a design language that feels like a real OS file manager:
// tight rows, monospaced details, colored file type pips.

const containerStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-surface)",
  borderRadius: 8,
  border: "1px solid var(--border-default)",
  overflow: "hidden",
  position: "relative",
};

const collapsedHeaderStyle: React.CSSProperties = {
  padding: "0 10px",
  height: "100%",
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  background: "var(--state-hover)",
  transition: "background 0.12s",
};

const headerStyle: React.CSSProperties = {
  padding: "10px 12px 8px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  borderBottom: "1px solid var(--border-default)",
  flexShrink: 0,
  background: "var(--state-hover)",
  gap: 8,
};

const chevronStyle: React.CSSProperties = {
  fontSize: 7,
  color: "var(--text-muted)",
  flexShrink: 0,
  transition: "transform 0.15s",
  lineHeight: 1,
};

const folderIconStyle: React.CSSProperties = {
  fontSize: 16,
  flexShrink: 0,
  lineHeight: 1,
  filter: "saturate(0.8)",
};

const folderIconCollapsedStyle: React.CSSProperties = {
  fontSize: 13,
  flexShrink: 0,
  lineHeight: 1,
  filter: "saturate(0.7)",
};

const headerNameStyle: React.CSSProperties = {
  fontSize: 13,
  fontFamily: "var(--font-sans)",
  fontWeight: 600,
  color: "var(--text-primary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
};

const collapsedNameStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--text-primary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
};

const collapsedCountStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: "var(--font-mono)",
  color: "var(--text-muted)",
  flexShrink: 0,
  opacity: 0.6,
};

const headerMetaStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
};

const statPillStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--text-muted)",
  display: "flex",
  alignItems: "center",
  gap: 3,
};

const pathBarStyle: React.CSSProperties = {
  padding: "5px 12px",
  borderBottom: "1px solid var(--border-default)",
  flexShrink: 0,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
  background: "var(--state-hover)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  letterSpacing: 0.2,
};

const listingContainerStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "4px 0",
};

const statusStyle: React.CSSProperties = {
  padding: "20px 12px",
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
};

const entryRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "3px 12px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  lineHeight: 1,
  cursor: "default",
  transition: "background 0.08s",
};

const dirIndicatorStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 1,
  background: "var(--accent)",
  flexShrink: 0,
  opacity: 0.7,
};

const fileIndicatorStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  flexShrink: 0,
  opacity: 0.8,
};

const entryNameStyle: React.CSSProperties = {
  color: "var(--text-primary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
};

const entryTagStyle: React.CSSProperties = {
  fontSize: 8,
  fontWeight: 600,
  fontFamily: "var(--font-mono)",
  color: "var(--accent)",
  letterSpacing: 0.8,
  flexShrink: 0,
  opacity: 0.6,
};

const fileTagStyle: React.CSSProperties = {
  fontSize: 8,
  fontWeight: 600,
  fontFamily: "var(--font-mono)",
  letterSpacing: 0.5,
  flexShrink: 0,
  padding: "1px 4px",
  borderRadius: 3,
  border: "1px solid",
};

const fileSizeStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: "var(--font-mono)",
  color: "var(--text-muted)",
  flexShrink: 0,
  opacity: 0.5,
};

const separatorStyle: React.CSSProperties = {
  height: 1,
  margin: "4px 12px",
  background: "var(--border-default)",
  opacity: 0.5,
};

const footerStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderTop: "1px solid var(--border-default)",
  flexShrink: 0,
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--text-muted)",
  opacity: 0.6,
  letterSpacing: 0.3,
};

// ── Registration ──────────────────────────────────────

registerNodeType({
  type: "folder",
  label: "Folder",
  defaultSize: { width: 320, height: COLLAPSED_HEIGHT },
  render: FolderNodeRenderer,
  userCreatable: false,
  providesContext: true,
  extractContent: (data) => (data as { loadedContent?: string })?.loadedContent ?? null,
});
