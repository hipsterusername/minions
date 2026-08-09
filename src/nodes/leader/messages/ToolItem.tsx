import { memo, useCallback, useMemo, useState } from "react";
import type { DisplayMessage } from "../../../sdk-messages.ts";
import {
  formatToolInput,
  formatToolInputDetail,
  toolDisplayInfo,
} from "../../leader-message-helpers.ts";
import type { LeaderMessage } from "../types.ts";

/**
 * A single collapsed tool-use row. Click to expand and show the raw tool
 * input as pretty-printed JSON. Used inside {@link LeaderToolGroup}.
 */
export const ToolItem = memo(function ToolItem({
  msg,
  accentColor,
}: {
  msg: LeaderMessage | DisplayMessage;
  accentColor: string;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const display = toolDisplayInfo(msg.toolName, msg.toolInput);
  const summary = display.summary ?? formatToolInput(msg.toolName ?? "", msg.toolInput);
  const hasInput = msg.toolInput && Object.keys(msg.toolInput).length > 0;

  return (
    <div>
      <div
        onClick={hasInput ? () => setDetailOpen(!detailOpen) : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
          lineHeight: 1.6,
          cursor: hasInput ? "pointer" : "default",
          borderRadius: 3,
          padding: "1px 4px",
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => {
          if (hasInput) e.currentTarget.style.background = `${accentColor}11`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <span
          style={{
            color: accentColor,
            opacity: 0.5,
            fontSize: 10,
            flexShrink: 0,
            width: 12,
            textAlign: "center",
            borderRadius: 3,
            background: `${accentColor}12`,
            fontWeight: 800,
          }}
        >
          {display.icon}
        </span>
        <span style={{ fontWeight: 500, flexShrink: 0 }}>
          {display.label}
        </span>
        {summary && (
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: 0.5,
              flex: 1,
              minWidth: 0,
            }}
          >
            {summary}
          </span>
        )}
        {hasInput && (
          <span
            style={{
              fontSize: 8,
              opacity: 0.35,
              flexShrink: 0,
              transition: "transform 0.15s",
              transform: detailOpen ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            &#9654;
          </span>
        )}
      </div>
      {detailOpen && hasInput && (
        <pre
          style={{
            margin: "2px 0 4px 22px",
            padding: "6px 8px",
            background: `${accentColor}08`,
            border: `1px solid ${accentColor}18`,
            borderRadius: 4,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 200,
            overflow: "auto",
            lineHeight: 1.5,
          }}
        >
          {formatToolInputDetail(msg.toolInput)}
        </pre>
      )}
    </div>
  );
});

/**
 * Collapsible cluster of consecutive tool-use rows. Renders a single
 * summary button (e.g. "Read, Edit +2 · 4") that expands into a list of
 * {@link ToolItem}s.
 */
export const LeaderToolGroup = memo(function LeaderToolGroup({
  msgs,
}: {
  msgs: LeaderMessage[];
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => {
    const toolNames = msgs.map((m) => m.toolName ?? "tool");
    const uniqueTools = [...new Set(toolNames.map((name) => toolDisplayInfo(name).shortLabel))];
    return uniqueTools.length <= 3
      ? uniqueTools.join(", ")
      : `${uniqueTools.slice(0, 2).join(", ")} +${uniqueTools.length - 2}`;
  }, [msgs]);
  const handleToggle = useCallback(() => setExpanded((value) => !value), []);

  return (
    <div style={{ marginBlock: 2 }}>
      <button
        onClick={handleToggle}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "4px 8px",
          background: expanded ? "var(--tool-bg)" : "transparent",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          textAlign: "left",
          transition: "color 0.15s, background 0.15s",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.color = "var(--text-dim)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.color = "var(--text-muted)")
        }
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            fontSize: 8,
            borderRadius: 3,
            background: "var(--tool-bg-hover)",
            color: "var(--tool-accent)",
            flexShrink: 0,
            transition: "transform 0.2s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          &#9654;
        </span>
        <span style={{ opacity: 0.7 }}>{summary}</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            opacity: 0.4,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {msgs.length}
        </span>
      </button>

      <div
        style={{
          display: "grid",
          gridTemplateRows: expanded ? "1fr" : "0fr",
          transition: "grid-template-rows 0.2s ease-out",
        }}
      >
        <div style={{ overflow: "hidden" }}>
          <div
            style={{
              paddingBlock: 2,
              paddingLeft: 24,
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {msgs.map((m) => (
              <ToolItem key={m.id} msg={m} accentColor="var(--tool-accent)" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
