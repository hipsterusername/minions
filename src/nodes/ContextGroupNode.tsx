import { useEffect, useRef } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";

// Contract is already registered in graph.ts (CONTEXT_GROUP_CONTRACT)

export interface ContextGroupData {
  name: string;
}

// ── Inject keyframe animations ──────────────────────────
const ANIMATION_CSS = `
@keyframes ctxGroupBorderGlow {
  0%, 100% { box-shadow: inset 0 0 30px color-mix(in srgb, var(--accent) 4%, transparent), 0 0 20px color-mix(in srgb, var(--accent) 8%, transparent); }
  50% { box-shadow: inset 0 0 40px color-mix(in srgb, var(--accent) 8%, transparent), 0 0 35px color-mix(in srgb, var(--accent) 14%, transparent); }
}
@keyframes ctxGroupPulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.8; }
}
@keyframes ctxGroupDropZonePulse {
  0%, 100% { opacity: 0.5; transform: translateX(-50%) scaleY(1); }
  50% { opacity: 1; transform: translateX(-50%) scaleY(1.05); }
}
@keyframes ctxGroupBorderDash {
  0% { background-position: 0 0; }
  100% { background-position: 24px 0; }
}
`;
let animStyleInjected = false;
function injectAnimStyles() {
  if (animStyleInjected) return;
  animStyleInjected = true;
  const el = document.createElement("style");
  el.textContent = ANIMATION_CSS;
  document.head.appendChild(el);
}

// ── Styles ────────────────────────────────────────────

const ACCENT = "var(--accent)";
const ACCENT_ACTIVE = "var(--accent)"; // brighter when drop target
const BORDER_COLOR = "color-mix(in srgb, var(--accent) 25%, transparent)";
const BORDER_ACTIVE = "color-mix(in srgb, var(--accent) 70%, transparent)";
const BG = "color-mix(in srgb, var(--accent) 2%, transparent)";
const BG_ACTIVE = "var(--state-active)";

// ── Component ─────────────────────────────────────────

function ContextGroupRenderer({
  node,
  onUpdateData,
  getContextForNode,
  isSelected,
  isDropTarget = false,
  isBeingDragged = false,
}: NodeRenderProps) {
  const data = node.data as ContextGroupData;
  const contextItems = getContextForNode?.() ?? [];
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { injectAnimStyles(); }, []);

  const update = (patch: Partial<ContextGroupData>) =>
    onUpdateData({ ...data, ...patch });

  const totalChars = contextItems.reduce((sum, i) => sum + i.content.length, 0);

  const borderColor = isDropTarget ? BORDER_ACTIVE : (isSelected ? "color-mix(in srgb, var(--accent) 50%, transparent)" : BORDER_COLOR);
  const bgColor = isDropTarget ? BG_ACTIVE : BG;
  const accentColor = isDropTarget ? ACCENT_ACTIVE : ACCENT;

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: bgColor,
        borderRadius: 12,
        border: `1.5px ${isDropTarget ? "solid" : "dashed"} ${borderColor}`,
        overflow: "visible",
        position: "relative",
        pointerEvents: "none",
        transition: "background 0.25s ease, border-color 0.25s ease, box-shadow 0.3s ease",
        boxShadow: isDropTarget
          ? `inset 0 0 60px color-mix(in srgb, var(--accent) 5%, transparent), 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent)`
          : "none",
      }}
    >
      {/* Animated border overlay — visible during drop target state */}
      {isDropTarget && (
        <div
          style={{
            position: "absolute",
            inset: -3,
            borderRadius: 14,
            border: `2px solid transparent`,
            pointerEvents: "none",
            zIndex: 0,
            animation: "ctxGroupBorderGlow 1.5s ease-in-out infinite",
          }}
        />
      )}

      {/* Ambient glow pulse — background effect when hovering */}
      {isDropTarget && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 12,
            background: `radial-gradient(ellipse at 50% 70%, color-mix(in srgb, var(--accent) 12%, transparent) 0%, transparent 70%)`,
            animation: "ctxGroupPulse 1.5s ease-in-out infinite",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      )}

      {/* Title bar — only interactive part */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          pointerEvents: "auto",
          // When being dragged the parent's drop-shadow filter creates a new
          // backdrop root, which breaks backdropFilter (it blurs empty space
          // instead of the canvas).  Use a fully opaque background to
          // keep the header visible.
          background: isBeingDragged
            ? "var(--bg-surface)"
            : isDropTarget
              ? "color-mix(in srgb, var(--bg-secondary) 92%, transparent)"
              : "color-mix(in srgb, var(--bg-secondary) 85%, transparent)",
          borderRadius: "12px 12px 0 0",
          borderBottom: `1px solid ${borderColor}`,
          backdropFilter: isBeingDragged ? "none" : "blur(8px)",
          flexShrink: 0,
          transition: "background 0.25s ease, border-color 0.25s ease",
          position: "relative",
          zIndex: 1,
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            background: "var(--state-active)",
            border: `1px solid color-mix(in srgb, ${accentColor} 25%, transparent)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: accentColor,
            flexShrink: 0,
            transition: "color 0.25s, border-color 0.25s, background 0.25s",
          }}
        >
          {isDropTarget ? "+" : "\u229E"}
        </div>

        <input
          value={data.name}
          onChange={(e) => update({ name: e.target.value })}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            color: isDropTarget ? ACCENT_ACTIVE : "var(--text-primary)",
            fontSize: 12,
            fontWeight: 600,
            outline: "none",
            padding: "2px 4px",
            minWidth: 0,
            fontFamily: "var(--font-sans)",
            transition: "color 0.25s",
          }}
          placeholder="Context Group"
        />

        {/* Source count badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
          }}
        >
          {contextItems.length > 0 && (
            <span
              style={{
                fontSize: 9,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                opacity: 0.7,
              }}
            >
              {formatSize(totalChars)}
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              color: contextItems.length > 0 ? accentColor : "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              background: contextItems.length > 0
                ? "var(--state-active)"
                : "var(--state-hover)",
              padding: "1px 6px",
              borderRadius: 8,
              fontWeight: 600,
              transition: "color 0.25s, background 0.25s",
            }}
          >
            {isDropTarget ? `${contextItems.length + 1}` : contextItems.length}
          </span>
        </div>
      </div>

      {/* Drop zone indicator — shows where the node will land */}
      {isDropTarget && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            width: "calc(100% - 32px)",
            pointerEvents: "none",
            zIndex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            animation: "ctxGroupDropZonePulse 1.2s ease-in-out infinite",
          }}
        >
          {/* Dashed drop placeholder */}
          <div
            style={{
              width: "100%",
              height: 40,
              borderRadius: 6,
              border: `1.5px dashed color-mix(in srgb, var(--accent) 50%, transparent)`,
              background: "var(--state-active)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={ACCENT_ACTIVE} strokeWidth="1.5" opacity="0.7">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            <span
              style={{
                fontSize: 10,
                color: ACCENT_ACTIVE,
                fontFamily: "var(--font-mono)",
                fontWeight: 500,
                opacity: 0.8,
                letterSpacing: "0.02em",
              }}
            >
              Drop to add context
            </span>
          </div>
        </div>
      )}

      {/* Empty-state hint (shown when no nodes inside and not a drop target) */}
      {contextItems.length === 0 && !isDropTarget && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -30%)",
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            lineHeight: 1.8,
            opacity: 0.5,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          Place context nodes inside this frame
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars}c`;
  if (chars < 10_000) return `${(chars / 1000).toFixed(1)}k`;
  return `${Math.round(chars / 1000)}k`;
}

// ── Registration ──────────────────────────────────────

registerNodeType({
  type: "context-group",
  label: "Context Group",
  defaultSize: { width: 660, height: 440 },
  render: ContextGroupRenderer,
});
