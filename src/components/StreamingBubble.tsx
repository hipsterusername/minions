/**
 * StreamingBubble – renders partial assistant text with a blinking cursor.
 * Shared across ClaudeSessionNode, MinionNode, and LeaderNode.
 *
 * Styled via chatRoleStyle() so the streaming line sits in the same
 * indent column and body color as the eventual finished message — no
 * visual jump when streaming completes.
 */

import { useEffect, useRef } from "react";
import { chatRoleStyle, type ChatRole } from "../chat-bubble-style.ts";

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
  /**
   * Which role this stream will resolve to. Drives indent + body color
   * so the streaming line matches the eventual finished message.
   * Default: assistant.
   */
  role?: ChatRole;
  /** Density variant matching the host surface. Default: default. */
  density?: "default" | "compact";
}

export function StreamingBubble({
  text,
  role = "assistant",
  density = "default",
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
        ...chatRoleStyle(role, { density }),
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
          background: "currentColor",
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
