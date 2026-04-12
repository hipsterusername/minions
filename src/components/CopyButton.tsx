import { useState, useCallback } from "react";

/**
 * A small copy-to-clipboard icon that appears on hover of its parent.
 * The parent must have `position: relative` and a `group` class (or use
 * the `CopyableWrapper` helper).
 *
 * Usage:
 *   <div style={{ position: "relative" }} className="copyable">
 *     <CopyButton text={contentToCopy} />
 *     ...children
 *   </div>
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [text],
  );

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className="copy-btn"
      style={{
        position: "absolute",
        top: 4,
        right: 4,
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: copied ? "var(--success-bg)" : "var(--bg-elevated)",
        border: `1px solid ${copied ? "var(--success-color)" : "var(--border-default)"}`,
        borderRadius: 4,
        cursor: "pointer",
        opacity: 0,
        transition: "opacity 150ms ease, background 150ms ease",
        zIndex: 5,
        padding: 0,
        color: copied ? "var(--success-color)" : "var(--text-secondary)",
      }}
    >
      {copied ? (
        /* checkmark icon */
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        /* copy icon */
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}
