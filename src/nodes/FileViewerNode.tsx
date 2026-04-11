import { useState, useEffect, useRef } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, CONTEXT_OUT_PORT } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import { getAuthToken } from "../api.ts";


// ── Graph contract ─────────────────────────────────────

const FILE_VIEWER_CONTRACT: NodeInterfaceContract = {
  nodeType: "file-viewer",
  label: "File Viewer",
  description:
    "Renders a project file read-only. Markdown is rendered; code shows with line numbers.",
  ports: [CONTEXT_OUT_PORT],
};

registerContract(FILE_VIEWER_CONTRACT);

// ── Types ──────────────────────────────────────────────

export interface FileViewerData {
  /** Relative file path from project root */
  filePath: string;
  /** Cached file content for context system (set after fetch) */
  loadedContent?: string;
  /** Whether the viewer is collapsed (default: true) */
  collapsed?: boolean;
  /** Remembered expanded height so we can restore on un-collapse */
  expandedHeight?: number;
}

// ── Helpers ────────────────────────────────────────────

const BG = "var(--bg-surface)";
const BORDER = "var(--border-default)";
const HEADER_BG = "var(--state-hover)";
/** Height of the node when collapsed — just the single header row */
const COLLAPSED_HEIGHT = 38;
const DEFAULT_EXPANDED_HEIGHT = 420;

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MARKDOWN_EXTS = new Set(["md", "mdx"]);

// ── Simple markdown → HTML ────────────────────────────

function renderMarkdown(src: string): string {
  const escaped = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = escaped.split("\n");
  const html: string[] = [];
  let inList = false;
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        html.push("</code></pre>");
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        html.push(
          '<pre style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:4px;overflow-x:auto;margin:6px 0"><code>',
        );
      }
      continue;
    }
    if (inCodeBlock) {
      html.push(line + "\n");
      continue;
    }

    if (inList && !line.startsWith("- ") && !line.startsWith("* ")) {
      html.push("</ul>");
      inList = false;
    }

    if (line.startsWith("### ")) {
      html.push(`<h5 style="margin:10px 0 4px">${inlineFmt(line.slice(4))}</h5>`);
    } else if (line.startsWith("## ")) {
      html.push(`<h4 style="margin:12px 0 4px">${inlineFmt(line.slice(3))}</h4>`);
    } else if (line.startsWith("# ")) {
      html.push(`<h3 style="margin:14px 0 6px">${inlineFmt(line.slice(2))}</h3>`);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!inList) {
        html.push('<ul style="margin:4px 0;padding-left:20px">');
        inList = true;
      }
      html.push(`<li>${inlineFmt(line.slice(2))}</li>`);
    } else if (line.startsWith("> ")) {
      html.push(
        `<blockquote style="border-left:3px solid var(--text-muted);margin:4px 0;padding:2px 10px;opacity:0.8">${inlineFmt(line.slice(2))}</blockquote>`,
      );
    } else if (line.trim() === "") {
      html.push("<br>");
    } else {
      html.push(`<p style="margin:4px 0">${inlineFmt(line)}</p>`);
    }
  }

  if (inList) html.push("</ul>");
  if (inCodeBlock) html.push("</code></pre>");
  return html.join("\n");
}

function inlineFmt(text: string): string {
  return text
    .replace(
      /`([^`]+)`/g,
      '<code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;font-size:0.9em">$1</code>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" style="color:var(--accent)">$1</a>',
    );
}

// ── Line-numbered code view ───────────────────────────

function CodeView({ content }: { content: string }) {
  const lines = content.split("\n");
  const pad = String(lines.length).length;

  return (
    <div
      style={{
        padding: "10px 0",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        lineHeight: 1.6,
        tabSize: 2,
      }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            minHeight: "1.6em",
            padding: "0 12px",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: `${pad + 1}ch`,
              textAlign: "right",
              color: "var(--text-muted)",
              opacity: 0.35,
              userSelect: "none",
              flexShrink: 0,
              paddingRight: "1.5ch",
            }}
          >
            {i + 1}
          </span>
          <span
            style={{
              flex: 1,
              whiteSpace: "pre",
              overflowX: "auto",
              color: "var(--text-primary)",
            }}
          >
            {line || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────

function FileViewerNodeRenderer({
  node,
  projectPath,
  onResize,
  onUpdateData,
  canvasScale,
}: NodeRenderProps) {
  const data = node.data as FileViewerData;
  const collapsed = data.collapsed !== false; // default true
  const [content, setContent] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const encoded = projectPath ? encodePath(projectPath) : null;
  const ext = extOf(data.filePath);
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const fileName = data.filePath ? data.filePath.split("/").pop() ?? data.filePath : "";
  const lineCount = content ? content.split("\n").length : 0;

  // Track pointer start position so we can distinguish a click (expand/collapse)
  // from a drag (move the node). Without this, onMouseDown stopPropagation on
  // the collapsed header would prevent CanvasNode from ever initiating a drag.
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);

  const toggleCollapsed = () => {
    if (collapsed) {
      // Expanding — restore saved height
      const h = data.expandedHeight ?? DEFAULT_EXPANDED_HEIGHT;
      onUpdateData({ ...data, collapsed: false });
      onResize?.({ width: node.size.width, height: h });
    } else {
      // Collapsing — save current height, shrink node
      onUpdateData({ ...data, collapsed: true, expandedHeight: node.size.height });
      onResize?.({ width: node.size.width, height: COLLAPSED_HEIGHT });
    }
  };

  // Fetch file when path changes
  useEffect(() => {
    if (!encoded || !data.filePath) {
      setContent(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getAuthToken()
      .then((token) =>
        fetch(
          `/api/projects/${encoded}/file?path=${encodeURIComponent(data.filePath)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      )
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{
          content: string;
          size: number;
          truncated: boolean;
        }>;
      })
      .then((json) => {
        if (cancelled) return;
        setContent(json.content);
        setFileSize(json.size);
        setTruncated(json.truncated);
        // Persist to node data so the context system can read it
        onUpdateData({ ...data, loadedContent: json.content });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load");
        setContent(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [encoded, data.filePath]);

  // ── Collapsed view ────────────────────────────────────
  if (collapsed) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: BG,
          borderRadius: 8,
          border: `1px solid ${BORDER}`,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          onPointerDown={(e) => {
            clickStartRef.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={(e) => {
            if (clickStartRef.current) {
              const d =
                Math.abs(e.clientX - clickStartRef.current.x) +
                Math.abs(e.clientY - clickStartRef.current.y);
              clickStartRef.current = null;
              if (d < 5) toggleCollapsed();
            }
          }}
          style={{
            padding: "4px 8px",
            display: "flex",
            alignItems: "center",
            gap: 4,
            cursor: "pointer",
            background: HEADER_BG,
            flexShrink: 0,
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = HEADER_BG; }}
        >
          <span
            style={{
              fontSize: 6,
              color: "var(--text-muted)",
              flexShrink: 0,
              transition: "transform 0.15s",
            }}
          >
            &#9654;
          </span>
          <span
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
            title={data.filePath}
          >
            {fileName || "No file selected"}
          </span>
          {content !== null && (
            <span
              style={{
                fontSize: 9,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                flexShrink: 0,
                opacity: 0.6,
              }}
            >
              {lineCount}L {formatSize(fileSize)}
            </span>
          )}
          {loading && (
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
              ...
            </span>
          )}
          {error && (
            <span style={{ fontSize: 9, color: "var(--danger-color)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
              error
            </span>
          )}
        </div>
      </div>
    );
  }

  // ── Expanded view ─────────────────────────────────────
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: BG,
        borderRadius: 8,
        border: `1px solid ${BORDER}`,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: `1px solid ${BORDER}`,
          flexShrink: 0,
          background: HEADER_BG,
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <span
            onClick={toggleCollapsed}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              fontSize: 8,
              color: "var(--text-muted)",
              flexShrink: 0,
              cursor: "pointer",
              transition: "transform 0.15s",
              transform: "rotate(90deg)",
              padding: "2px 4px",
            }}
          >
            &#9654;
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 1,
              fontFamily: "var(--font-mono)",
              flexShrink: 0,
            }}
          >
            File Viewer
            <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--accent)" }}>
              {" "}&middot; Context
            </span>
          </span>
        </div>
        {content !== null && (
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              flexShrink: 0,
            }}
          >
            {formatSize(fileSize)}
            {truncated ? " (truncated)" : ""}
          </span>
        )}
      </div>

      {/* File path bar */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: `1px solid ${BORDER}`,
          flexShrink: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text-primary)",
          background: "rgba(255,255,255,0.02)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={data.filePath}
      >
        {data.filePath || "No file selected"}
      </div>

      {/* Rendered content */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        style={{ flex: 1, overflow: "auto", position: "relative" }}
      >
        {loading ? (
          <StatusMsg>Loading...</StatusMsg>
        ) : error ? (
          <StatusMsg
            style={{
              color: "var(--danger-color)",
              background: "var(--danger-bg)",
            }}
          >
            {error}
          </StatusMsg>
        ) : content === null ? (
          <StatusMsg>No file selected</StatusMsg>
        ) : isMarkdown ? (
          <div
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            style={{
              padding: "12px 16px",
              color: "var(--text-primary)",
              fontSize: 13,
              fontFamily: "var(--font-sans)",
              lineHeight: 1.6,
            }}
          />
        ) : (
          <CodeView content={content} />
        )}
      </div>

      {/* Resize handle */}
      {onResize && (
        <ResizeHandle
          currentSize={node.size}
          minWidth={280}
          minHeight={200}
          onResize={onResize}
          canvasScale={canvasScale}
        />
      )}
    </div>
  );
}

function StatusMsg({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        padding: 20,
        textAlign: "center",
        color: "var(--text-muted)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Registration ──────────────────────────────────────

registerNodeType({
  type: "file-viewer",
  label: "File Viewer",
  defaultSize: { width: 480, height: COLLAPSED_HEIGHT },
  render: FileViewerNodeRenderer,
  userCreatable: false,
});
