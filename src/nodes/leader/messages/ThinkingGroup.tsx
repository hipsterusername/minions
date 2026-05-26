import { memo, useCallback, useMemo, useState } from "react";
import { chatRoleStyle } from "../../../chat-bubble-style.ts";
import type { ThinkingConfig } from "../../../types.ts";
import type { LeaderMessage } from "../types.ts";

/**
 * Collapsible cluster of consecutive `thinking` blocks emitted by the
 * assistant. Shows an estimated token count and the configured effort
 * badge; expanding reveals the raw extended-thinking text.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 4 of the leader refactor).
 */
export const LeaderThinkingGroup = memo(function LeaderThinkingGroup({
  msgs,
  effort,
}: {
  msgs: LeaderMessage[];
  effort?: ThinkingConfig["effort"];
}) {
  const [expanded, setExpanded] = useState(false);
  const tokenLabel = useMemo(() => {
    const totalLen = msgs.reduce((sum, m) => sum + m.content.length, 0);
    const estTokens = Math.round(totalLen / 4);
    return estTokens >= 1000
      ? `~${(estTokens / 1000).toFixed(1)}k tokens`
      : `~${estTokens} tokens`;
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
          background: expanded ? "var(--thinking-bg)" : "transparent",
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
            fontSize: 10,
            borderRadius: 3,
            background: "var(--thinking-bg-hover)",
            color: "var(--thinking-accent)",
            flexShrink: 0,
            transition: "transform 0.2s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          &#9654;
        </span>
        <span style={{ opacity: 0.7, color: "var(--thinking-accent)" }}>
          Thinking
        </span>
        {effort && (
          <span
            style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--thinking-bg-hover)",
              color: "var(--thinking-accent)",
              opacity: 0.85,
              textTransform: "lowercase",
              letterSpacing: 0.2,
            }}
            title={`Adaptive thinking · effort: ${effort}`}
          >
            {effort}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            opacity: 0.4,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {tokenLabel}
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
              ...chatRoleStyle("thinking"),
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {msgs.map((m) => m.content).join("\n\n")}
          </div>
        </div>
      </div>
    </div>
  );
});
