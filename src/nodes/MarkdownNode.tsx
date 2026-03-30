import { useState } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";

interface MarkdownData {
  title: string;
  content: string;
  viewMode: "edit" | "preview";
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

// ── Simple markdown → HTML ─────────────────────────────

function renderMarkdown(src: string): string {
  const escaped = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = escaped.split("\n");
  const html: string[] = [];
  let inList = false;

  for (const line of lines) {
    // Close list if we leave list context
    if (inList && !line.startsWith("- ")) {
      html.push("</ul>");
      inList = false;
    }

    if (line.startsWith("## ")) {
      html.push(`<h4>${inlineFormat(line.slice(3))}</h4>`);
    } else if (line.startsWith("# ")) {
      html.push(`<h3>${inlineFormat(line.slice(2))}</h3>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineFormat(line.slice(2))}</li>`);
    } else if (line.trim() === "") {
      html.push("<br>");
    } else {
      html.push(`<p style="margin:4px 0">${inlineFormat(line)}</p>`);
    }
  }

  if (inList) html.push("</ul>");
  return html.join("\n");
}

function inlineFormat(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

// ── Component ──────────────────────────────────────────

const BG = "#1a2a1a";
const BORDER = "#2a3a2a";

function MarkdownNodeRenderer({ node, onUpdateData }: NodeRenderProps) {
  const data = node.data as MarkdownData;
  const [portHover, setPortHover] = useState(false);

  const update = (patch: Partial<MarkdownData>) =>
    onUpdateData({ ...data, ...patch });

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
      {/* Context port indicator */}
      <div
        onMouseEnter={() => setPortHover(true)}
        onMouseLeave={() => setPortHover(false)}
        title="Drag to connect as context to a Leader"
        style={{
          position: "absolute",
          right: -4,
          top: "50%",
          transform: "translateY(-50%)",
          width: 10,
          height: 10,
          borderRadius: "50%",
          backgroundColor: "#4ade80",
          opacity: portHover ? 1.0 : 0.5,
          boxShadow: portHover
            ? "0 0 8px rgba(74, 222, 128, 0.6)"
            : "none",
          transition: "opacity 0.15s, box-shadow 0.15s",
          zIndex: 10,
          cursor: "crosshair",
        }}
      />
      {/* Header */}
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: `1px solid ${BORDER}`,
          flexShrink: 0,
          gap: 8,
        }}
      >
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
          Markdown
          <span
            style={{
              color: "var(--text-muted)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {" "}· Context
          </span>
        </span>

        <input
          value={data.title}
          onChange={(e) => update({ title: e.target.value })}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            color: "var(--text-primary)",
            fontSize: 13,
            fontWeight: 600,
            outline: "none",
            textAlign: "center",
            padding: "2px 4px",
            minWidth: 0,
          }}
          placeholder="Untitled"
        />

        <button
          onClick={() =>
            update({
              viewMode: data.viewMode === "edit" ? "preview" : "edit",
            })
          }
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            color: "var(--text-muted)",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            padding: "2px 8px",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {data.viewMode === "edit" ? "Preview" : "Edit"}
        </button>
      </div>

      {/* Body */}
      {data.viewMode === "edit" ? (
        <textarea
          value={data.content}
          onChange={(e) => update({ content: e.target.value })}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="Write markdown..."
          style={{
            flex: 1,
            padding: "10px 12px",
            background: "transparent",
            border: "none",
            color: "var(--text-primary)",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            resize: "none",
            outline: "none",
            lineHeight: 1.6,
          }}
        />
      ) : (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(data.content) }}
          style={{
            flex: 1,
            padding: "10px 12px",
            color: "var(--text-primary)",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            lineHeight: 1.6,
            overflowY: "auto",
          }}
        />
      )}
    </div>
  );
}

// ── Registration ───────────────────────────────────────

registerNodeType({
  type: "markdown",
  label: "Markdown",
  defaultSize: { width: 360, height: 320 },
  render: MarkdownNodeRenderer,
});
