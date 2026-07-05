/**
 * ArtifactComponents — image and file-preview renderers.
 *
 * Standalone from RenderNode.tsx to avoid coupling to its registration
 * side-effects. Uses the same CSS variable tokens and "rd-card" / "rd-fade-in"
 * class names, which are injected by RenderNode.injectStyles() when the
 * dashboard node is rendered in the canvas.
 */

import { useState, useEffect } from "react";
import type { ImageComponent, FilePreviewComponent } from "../../../shared/render-artifacts.ts";
import { copyText } from "../../components/CopyButton.tsx";

// ── Shared card baseline style ────────────────────────────

const CARD: React.CSSProperties = {
  background: "var(--bg-secondary)",
  borderRadius: 8,
  border: "1px solid var(--border-default)",
};

// ── ImageRenderer ─────────────────────────────────────────

export function ImageRenderer({ c }: { c: ImageComponent }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const fit = c.fit ?? "contain";
  const objectFit = fit === "actual" ? "none" : fit;

  useEffect(() => {
    if (!lightboxOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen]);

  return (
    <>
      <div className="rd-card rd-card--hover rd-fade-in" style={{ ...CARD, overflow: "hidden", padding: 0 }}>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          aria-label="Open image lightbox"
          style={{
            display: "block",
            width: "100%",
            border: 0,
            padding: 0,
            background: "transparent",
            cursor: "zoom-in",
          }}
        >
          <img
            src={c.src}
            alt={c.alt}
            loading="lazy"
            style={{
              display: "block",
              width: c.width !== undefined ? c.width : "100%",
              height: c.height !== undefined ? c.height : "auto",
              objectFit,
            }}
          />
        </button>
        {c.caption !== undefined && (
          <div style={{
            padding: "6px 12px 8px",
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.4,
            fontStyle: "italic",
            borderTop: "1px solid var(--border-default)",
          }}>
            {c.caption}
          </div>
        )}
      </div>
      {lightboxOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image lightbox"
          onClick={() => setLightboxOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <img
            src={c.src}
            alt={c.alt}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              borderRadius: 4,
              boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ── View detection ────────────────────────────────────────

type ViewMode = "text" | "json" | "csv" | "image" | "hex";

function detectView(
  filename: string | undefined,
  mime: string | undefined,
  explicit: string | undefined,
): ViewMode {
  if (explicit !== undefined && explicit !== "auto") return explicit as ViewMode;
  if (mime?.startsWith("image/") === true) return "image";
  if (mime === "application/json") return "json";
  if (mime === "text/csv") return "csv";
  const ext = filename?.split(".").at(-1)?.toLowerCase();
  if (ext === "json") return "json";
  if (ext === "csv") return "csv";
  return "text";
}

// ── Content helpers ───────────────────────────────────────

function parseCSV(text: string): string[][] {
  return text
    .split("\n")
    .slice(0, 51) // header + up to 50 data rows
    .filter((row) => row.trim().length > 0)
    .map((row) => row.split(",").map((cell) => cell.trim()));
}

function hexDump(text: string): string {
  const ROW = 16;
  const bytes = [...text].map((ch) => ch.charCodeAt(0));
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += ROW) {
    const chunk = bytes.slice(i, i + ROW);
    const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = chunk
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(ROW * 3 - 1)}  ${ascii}`);
  }
  return lines.join("\n");
}

// ── JsonTree (one level deep) ─────────────────────────────

function JsonTree({ text }: { text: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return (
      <pre style={{ margin: 0, padding: "10px 12px", fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--status-error)" }}>
        Invalid JSON
      </pre>
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return (
      <pre style={{ margin: 0, padding: "10px 12px", fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-primary)", lineHeight: 1.6, overflowX: "auto" }}>
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  return (
    <div style={{ padding: "8px 12px" }}>
      {entries.map(([key, val]) => (
        <div key={key} style={{ display: "flex", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--border-default)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
          <span style={{ color: "var(--accent)", flexShrink: 0 }}>{key}</span>
          <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>:</span>
          <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {JSON.stringify(val)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── CsvTable ──────────────────────────────────────────────

function CsvTable({ text }: { text: string }) {
  const rows = parseCSV(text);
  if (rows.length === 0) {
    return <div style={{ padding: "10px 12px", color: "var(--text-muted)", fontSize: 11 }}>Empty CSV</div>;
  }
  const headers = rows[0] ?? [];
  const dataRows = rows.slice(1);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "var(--font-mono)" }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{ padding: "6px 10px", textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border-default)", background: "var(--bg-elevated)", whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, ri) => (
            <tr key={ri} style={{ borderBottom: "1px solid var(--border-default)" }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ padding: "4px 10px", color: "var(--text-primary)", whiteSpace: "nowrap" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── PreviewBody ───────────────────────────────────────────

interface PreviewBodyProps {
  viewMode: ViewMode;
  content: string;
  mime: string | undefined;
}

function PreviewBody({ viewMode, content, mime }: PreviewBodyProps) {
  return (
    <div style={{ maxHeight: 300, overflowY: "auto" }}>
      {viewMode === "json" && <JsonTree text={content} />}
      {viewMode === "csv" && <CsvTable text={content} />}
      {viewMode === "image" && (
        <img
          src={`data:${mime ?? "image/png"};base64,${content}`}
          alt="file preview"
          style={{ maxWidth: "100%", display: "block" }}
        />
      )}
      {viewMode === "hex" && (
        <pre style={{ margin: 0, padding: "10px 12px", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-primary)", overflowX: "auto", lineHeight: 1.5 }}>
          {hexDump(content)}
        </pre>
      )}
      {viewMode === "text" && (
        <pre style={{ margin: 0, padding: "10px 12px", fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-primary)", overflowX: "auto", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {content}
        </pre>
      )}
    </div>
  );
}

// ── Action button ─────────────────────────────────────────

function ActionBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "3px 9px",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 4,
        color: "var(--text-secondary)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

// ── PathSourcePreview ─────────────────────────────────────
//
// For path-source components, file content is not available client-side in v1.
// Actual file fetching (via a server endpoint that reads the path and streams
// the content back) is out of scope for v1. We render a placeholder card with
// the filename and a Download action (window.open) only.

function PathSourcePreview({ c }: { c: FilePreviewComponent }) {
  const src = c.source;
  if (src.kind !== "path") return null; // type guard
  // Extract narrowed values into standalone consts before any inner function
  // definitions — hoisted `function` declarations cause TypeScript to widen the
  // discriminated-union narrowing back to the full union throughout the scope.
  const srcPath = src.path;

  const displayName = c.filename ?? srcPath;
  const enabledActions = c.actions ?? ["download"];

  function handleDownload() {
    window.open(srcPath, "_blank", "noopener");
  }

  function handleCopyPath() {
    void copyText(srcPath).catch((err: unknown) => {
      console.warn("[ArtifactComponents] copy path failed:", err);
    });
  }

  return (
    <div className="rd-card rd-fade-in" style={{ ...CARD, overflow: "hidden" }}>
      <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border-default)", background: "var(--bg-elevated)" }}>
        <span style={{ flex: 1, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {displayName}
        </span>
        {enabledActions.includes("download") && <ActionBtn label="Download" onClick={handleDownload} />}
        {enabledActions.includes("copy-path") && <ActionBtn label="Copy path" onClick={handleCopyPath} />}
      </div>
      <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: 11, fontStyle: "italic" }}>
        File content not available client-side.
      </div>
    </div>
  );
}

// ── InlineSourcePreview ───────────────────────────────────

function InlineSourcePreview({ c }: { c: FilePreviewComponent }) {
  const src = c.source;
  if (src.kind !== "inline") return null; // type guard
  // Extract narrowed values before inner function definitions (see PathSourcePreview
  // for the rationale — hoisted functions widen the discriminated-union narrowing).
  const rawContent = src.content;
  const srcMime = src.mime;

  const maxBytes = c.maxBytes;
  const isTruncated = maxBytes !== undefined && rawContent.length > maxBytes;
  const content = isTruncated ? rawContent.slice(0, maxBytes) : rawContent;
  const sizeLabel = `${rawContent.length}B`;
  const byteCap = maxBytes ?? 0;
  const bytesOmitted = isTruncated ? rawContent.length - byteCap : 0;
  const viewMode = detectView(c.filename, srcMime, c.view);
  const enabledActions = c.actions ?? ["open"];

  function handleOpen() {
    const blob = new Blob([rawContent], { type: srcMime ?? "text/plain" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
  }

  function handleDownload() {
    const blob = new Blob([rawContent], { type: srcMime ?? "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = c.filename ?? "download";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rd-card rd-fade-in" style={{ ...CARD, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderBottom: "1px solid var(--border-default)", background: "var(--bg-elevated)" }}>
        {c.filename !== undefined && (
          <span style={{ flex: 1, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            {c.filename}
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
          {sizeLabel}
        </span>
        {enabledActions.includes("open") && <ActionBtn label="Open" onClick={handleOpen} />}
        {enabledActions.includes("download") && <ActionBtn label="Download" onClick={handleDownload} />}
      </div>
      {/* Body */}
      <PreviewBody viewMode={viewMode} content={content} mime={srcMime} />
      {/* Truncation banner */}
      {isTruncated && (
        <div style={{ padding: "6px 12px", fontSize: 10, color: "var(--status-warning)", background: "var(--warning-bg)", borderTop: "1px solid var(--border-default)", fontFamily: "var(--font-mono)" }}>
          Truncated at {byteCap} bytes ({bytesOmitted} bytes omitted)
        </div>
      )}
    </div>
  );
}

// ── FilePreviewRenderer ───────────────────────────────────

export function FilePreviewRenderer({ c }: { c: FilePreviewComponent }) {
  if (c.source.kind === "path") return <PathSourcePreview c={c} />;
  return <InlineSourcePreview c={c} />;
}
