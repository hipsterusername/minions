// ── Chat-bubble style contract (no chrome) ─────────────────────────
//
// Role meaning lives in the body itself: indent + type family/weight/size
// + body color. NO borders, NO bg fills, NO rounded corners around messages.
// Vertical rhythm + indent cascade + type carry the role.
//
// Indent ladder (in px, including a 10px base padding):
//   user      → 10  (flush; tinted block; accent color)
//   assistant → 26  (16px past user)
//   result    → 26  (sibling to assistant; success-color body)
//   system    → 26  (sibling; muted; small)
//   tool      → 42  (32px past user; mono; muted)
//   thinking  → 58  (48px past user; italic; dim)
//
// User flush-left is symmetric (paddingInline) because it's a tinted
// block, not part of the cascade — the cascade starts with assistant.
//
// The cascade reads left-to-right as a conversation tree: human speaks,
// AI replies, AI uses tools, AI thinks. Long replies stay in the same
// column as their parent message, so eye flow is continuous.

import type { CSSProperties } from "react";

export type ChatRole =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "thinking"
  | "result";

export interface ChatRoleStyleOptions {
  /**
   * Density variant. `compact` shaves ~1px off body type and tightens
   * vertical rhythm — used inside MinionNode's execution log where
   * messages stack tightly. `default` is the chat surface size.
   */
  density?: "default" | "compact";
  /**
   * Mark a result as an error. Swaps body color from success to error
   * but keeps the result indent + weight, so the placement still reads
   * as a result line rather than an inline error.
   */
  isError?: boolean;
}

const BASE_PADDING = 10;
const INDENT_REPLY = 16;
const INDENT_TOOL = 32;
const INDENT_THINKING = 48;

/**
 * Inline style for a chat message at a given role.
 *
 * Intentionally returns a flat CSSProperties object so callers can
 * spread additional layout (`position`, `maxHeight`, etc.) without
 * having to know about role internals.
 */
export function chatRoleStyle(
  role: ChatRole,
  { density = "default", isError = false }: ChatRoleStyleOptions = {},
): CSSProperties {
  const compact = density === "compact";
  const base: CSSProperties = {
    paddingBlock: compact ? 2 : 4,
    paddingInlineEnd: BASE_PADDING,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowWrap: "break-word",
  };

  switch (role) {
    case "user":
      // The user row gets a small "on-theme" treatment: a low-alpha tint
      // mixed from the theme's --accent so the block picks up each
      // theme's identity automatically, a small 5px corner softening
      // (geometric chip, not a speech bubble), and tight compression so
      // it reads as a labeled context card rather than a chat turn.
      return {
        ...base,
        paddingBlock: compact ? 3 : 4,
        paddingInline: BASE_PADDING,
        marginBlockStart: compact ? 2 : 3,
        borderRadius: 5,
        fontFamily: "var(--font-sans)",
        fontWeight: 500,
        fontSize: compact ? 12 : 13,
        color: "var(--accent)",
        background: "color-mix(in srgb, var(--accent) 7%, transparent)",
      };
    case "assistant":
      return {
        ...base,
        paddingInlineStart: BASE_PADDING + INDENT_REPLY,
        fontFamily: "var(--font-sans)",
        fontWeight: 400,
        fontSize: compact ? 12 : 13,
        color: "var(--text-primary)",
      };
    case "result":
      return {
        ...base,
        paddingInlineStart: BASE_PADDING + INDENT_REPLY,
        fontFamily: "var(--font-sans)",
        fontWeight: 500,
        fontSize: compact ? 11 : 12,
        color: isError ? "var(--status-error)" : "var(--status-success)",
      };
    case "tool":
      return {
        ...base,
        paddingInlineStart: BASE_PADDING + INDENT_TOOL,
        fontFamily: "var(--font-mono)",
        fontWeight: 400,
        fontSize: 11,
        color: "var(--text-muted)",
      };
    case "thinking":
      return {
        ...base,
        paddingInlineStart: BASE_PADDING + INDENT_THINKING,
        fontFamily: "var(--font-sans)",
        fontWeight: 400,
        fontSize: 11,
        fontStyle: "italic",
        color: "var(--text-dim)",
      };
    case "system":
      return {
        ...base,
        paddingInlineStart: BASE_PADDING + INDENT_REPLY,
        fontFamily: "var(--font-sans)",
        fontWeight: 400,
        fontSize: 10,
        color: "var(--text-muted)",
        opacity: 0.6,
      };
  }
}
