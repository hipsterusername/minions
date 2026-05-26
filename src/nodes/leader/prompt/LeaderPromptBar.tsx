import { type KeyboardEvent, type RefObject } from "react";
import { AutoTextarea } from "../../../components/AutoTextarea.tsx";

/**
 * Shared Leader prompt bar used by both the in-node prompt and the
 * zoomed-out overlay. Keep prompt UI changes here so both affordances
 * evolve together.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 8 of the leader refactor).
 */
export function LeaderPromptBar({
  input,
  onInputChange,
  onKeyDown,
  onSubmit,
  placeholder,
  submitLabel,
  disabled,
  active,
  variant = "inline",
  autoFocus = false,
  textareaRef,
  onTextareaFocus,
}: {
  input: string;
  onInputChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSubmit: () => void;
  placeholder: string;
  submitLabel: string;
  disabled: boolean;
  active: boolean;
  variant?: "inline" | "overlay";
  autoFocus?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onTextareaFocus?: (() => void) | undefined;
}) {
  const isOverlay = variant === "overlay";
  const buttonHeight = isOverlay ? 52 : 38;
  const buttonMinWidth = isOverlay ? 124 : 88;
  const buttonIsPrimary = active && !disabled;

  return (
    <div
      data-testid={`leader-prompt-bar-${variant}`}
      data-no-drag
      style={{
        padding: isOverlay ? "10px" : "8px 10px",
        borderTop: isOverlay ? "none" : "1px solid var(--border-default)",
        display: "flex",
        gap: isOverlay ? 8 : 6,
        flexShrink: 0,
        background: isOverlay ? "transparent" : "var(--bg-secondary)",
        alignItems: "flex-end",
      }}
    >
      <AutoTextarea
        value={input}
        onChange={onInputChange}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        ariaLabel="Leader prompt"
        testId={`leader-prompt-input-${variant}`}
        placeholder={placeholder}
        maxRows={isOverlay ? 10 : 8}
        {...(onTextareaFocus ? { onFocus: onTextareaFocus } : {})}
        {...(textareaRef ? { textareaRef } : {})}
        style={{
          fontSize: isOverlay ? 15 : 12,
          lineHeight: isOverlay ? "24px" : "20px",
          padding: isOverlay ? "12px 14px" : "8px 10px",
          minHeight: isOverlay ? 52 : undefined,
        }}
      />
      <button
        type="button"
        onClick={onSubmit}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={disabled}
        style={{
          height: buttonHeight,
          minWidth: buttonMinWidth,
          padding: isOverlay ? "0 18px" : "0 14px",
          borderRadius: 6,
          border: buttonIsPrimary
            ? "1px solid var(--accent)"
            : "1px solid var(--border-default)",
          background: buttonIsPrimary ? "var(--accent)" : "var(--bg-elevated)",
          color: buttonIsPrimary ? "var(--text-on-accent)" : "var(--text-muted)",
          fontSize: isOverlay ? 13 : 12,
          fontWeight: 700,
          cursor: disabled ? "not-allowed" : "pointer",
          flexShrink: 0,
          opacity: disabled ? 0.62 : 1,
          marginBottom: isOverlay ? 0 : 1,
          boxShadow: buttonIsPrimary
            ? "0 2px 8px color-mix(in srgb, var(--accent) 24%, transparent)"
            : "none",
          transition:
            "background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease",
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {submitLabel}
      </button>
    </div>
  );
}
