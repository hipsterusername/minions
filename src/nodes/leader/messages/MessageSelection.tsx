import { memo, type MouseEvent, type ReactNode } from "react";

/**
 * Selection-toolbar primitives used when the user enters chunk-pick mode
 * on an assistant message bubble. Centralizes the icon SVGs, group
 * wrapper, and styled button so {@link SelectableMessageBubble} can
 * focus on selection logic.
 */

export type MessageSelectionIconKind =
  | "copy"
  | "node"
  | "select-all"
  | "clear"
  | "exit";

export function MessageSelectionIcon({ kind }: { kind: MessageSelectionIconKind }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (kind) {
    case "copy":
      return (
        <svg {...common}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "node":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M12 18v-6" />
          <path d="M9 15h6" />
        </svg>
      );
    case "select-all":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="m8 12 3 3 5-6" />
        </svg>
      );
    case "clear":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 9l6 6" />
          <path d="M15 9l-6 6" />
        </svg>
      );
    case "exit":
      return (
        <svg {...common}>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      );
  }
}

export function MessageSelectionGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-label={label}
      role="group"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        paddingInlineStart: 5,
        borderLeft: "1px solid var(--border-default)",
      }}
    >
      {children}
    </div>
  );
}

export const MessageSelectionButton = memo(function MessageSelectionButton({
  icon,
  label,
  onClick,
  disabled = false,
  tone = "neutral",
  title,
}: {
  icon: MessageSelectionIconKind;
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  tone?: "neutral" | "primary";
  title?: string | undefined;
}) {
  const isPrimary = tone === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      style={{
        width: 26,
        height: 26,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: 4,
        border: `1px solid ${
          disabled
            ? "var(--border-default)"
            : isPrimary
              ? "color-mix(in srgb, var(--accent) 54%, var(--border-default))"
              : "var(--border-default)"
        }`,
        background: disabled
          ? "var(--bg-primary)"
          : isPrimary
            ? "color-mix(in srgb, var(--accent) 14%, var(--bg-elevated))"
            : "var(--bg-elevated)",
        color: disabled
          ? "var(--text-dim)"
          : isPrimary
            ? "var(--accent)"
            : "var(--text-secondary)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <MessageSelectionIcon kind={icon} />
    </button>
  );
});
