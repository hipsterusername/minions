import { useState, useCallback } from "react";

/**
 * A small "add as node" button that appears on hover alongside CopyButton.
 * Creates a new markdown node on the canvas with the given text content.
 *
 * The parent must have `position: relative` and a `copyable` class.
 *
 * Usage:
 *   <div style={{ position: "relative" }} className="copyable">
 *     <CopyButton text={content} />
 *     <AddAsNodeButton text={content} onAdd={onAddContentNode} />
 *     ...children
 *   </div>
 */
export function AddAsNodeButton({
  text,
  onAdd,
}: {
  text: string;
  onAdd?: (content: string) => void;
}) {
  const [added, setAdded] = useState(false);

  const handleAdd = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (!onAdd) return;
      onAdd(text);
      setAdded(true);
      setTimeout(() => setAdded(false), 1500);
    },
    [text, onAdd],
  );

  if (!onAdd) return null;

  return (
    <button
      onClick={handleAdd}
      title="Add as node"
      className="copy-btn"
      style={{
        position: "absolute",
        top: 4,
        right: 32,
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: added ? "var(--tool-bg)" : "var(--bg-elevated)",
        border: `1px solid ${added ? "var(--info-color)" : "var(--border-default)"}`,
        borderRadius: 4,
        cursor: "pointer",
        opacity: 0,
        transition: "opacity 150ms ease, background 150ms ease",
        zIndex: 5,
        padding: 0,
        color: added ? "var(--info-color)" : "var(--text-secondary)",
      }}
    >
      {added ? (
        /* checkmark icon */
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        /* note/add icon — a document with a plus */
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
      )}
    </button>
  );
}
