import { useState, useCallback } from "react";

/**
 * Copy text to the clipboard, robust across browsers and contexts.
 *
 * `navigator.clipboard` is only defined in secure contexts. Firefox served
 * over a plain-http LAN address (e.g. http://192.168.x.x:5173) leaves it
 * `undefined`, so calling `.writeText` there throws synchronously. We fall
 * back to a hidden-textarea + `execCommand("copy")`, which still works in
 * that situation. Rejects if neither path succeeds so callers can react.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("execCommand('copy') returned false");
  } finally {
    document.body.removeChild(ta);
  }
}

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
export function CopyButton({
  text,
  layout = "absolute",
  alwaysVisible = false,
  title = "Copy to clipboard",
}: {
  text: string;
  layout?: "absolute" | "inline";
  alwaysVisible?: boolean;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const placementStyle =
    layout === "absolute"
      ? { position: "absolute" as const, top: 4, right: 4 }
      : { position: "static" as const, flex: "0 0 auto" };

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (err) {
        // Surface the failure instead of silently no-op'ing (Firefox in a
        // non-secure context leaves navigator.clipboard undefined).
        console.warn("[CopyButton] copy failed:", err);
      }
    },
    [text],
  );

  return (
    <button
      onClick={handleCopy}
      title={title}
      className="copy-btn"
      style={{
        ...placementStyle,
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: copied ? "var(--success-bg)" : "var(--bg-elevated)",
        border: `1px solid ${copied ? "var(--success-color)" : "var(--border-default)"}`,
        borderRadius: 4,
        cursor: "pointer",
        opacity: alwaysVisible ? 1 : 0,
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
