/**
 * StreamingBubble – renders partial assistant text with a blinking cursor.
 * Shared across ClaudeSessionNode, MinionNode, and LeaderNode.
 */

import { useEffect, useRef } from "react";

const CURSOR_KEYFRAMES = `
@keyframes streamCursorBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
`;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = CURSOR_KEYFRAMES;
  document.head.appendChild(style);
}

interface StreamingBubbleProps {
  /** Accumulated partial text so far */
  text: string;
  /** Border color to match the node's theme (default: var(--streaming-color)) */
  borderColor?: string;
}

export function StreamingBubble({
  text,
  borderColor = "var(--streaming-color)",
}: StreamingBubbleProps) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    injectStyle();
  }, []);

  // Auto-scroll is now handled by the parent container (ClaudeSessionNode).
  // This avoids forcing scroll when the user has intentionally scrolled up.

  return (
    <div
      ref={elRef}
      style={{
        padding: "8px 10px",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.6,
        fontFamily: "var(--font-sans)",
        color: "var(--text-primary)",
        borderLeft: `2px solid ${borderColor}`,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowWrap: "break-word",
        marginBlock: 2,
        position: "relative",
      }}
    >
      {text || "\u00A0"}
      <span
        style={{
          display: "inline-block",
          width: 2,
          height: "1.1em",
          marginLeft: 1,
          background: borderColor,
          verticalAlign: "text-bottom",
          animation: "streamCursorBlink 0.8s ease-in-out infinite",
        }}
      />
    </div>
  );
}

/**
 * Compact streaming indicator shown when text hasn't started yet.
 * Displays a pulsing dot + label.
 */
export function StreamingIndicator({ label = "Thinking..." }: { label?: string }) {
  useEffect(() => {
    injectStyle();
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        marginBlock: 2,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--streaming-color)",
          animation: "streamCursorBlink 1s ease-in-out infinite",
        }}
      />
      {label}
    </div>
  );
}
