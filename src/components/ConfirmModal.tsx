import { useEffect, useId, useRef, type ReactNode } from "react";

export interface ConfirmModalAction {
  label: string;
  variant?: "primary" | "danger" | "ghost";
  onClick: () => void;
}

interface ConfirmModalProps {
  title: string;
  description?: ReactNode;
  actions: ConfirmModalAction[];
  onClose: () => void;
}

export function ConfirmModal({ title, description, actions, onClose }: ConfirmModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      onMouseDown={(e) => { if (e.target === backdropRef.current) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--overlay-bg)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-default)",
          borderRadius: 12,
          padding: "20px 24px",
          minWidth: 340,
          maxWidth: 420,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div id={titleId} style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
          {title}
        </div>

        {description && (
          <div id={descriptionId} style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, fontFamily: "var(--font-sans)" }}>
            {description}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              ...buttonBase,
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
            }}
          >
            Cancel
          </button>
          {actions.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              style={{
                ...buttonBase,
                ...(action.variant === "danger" ? dangerStyle : action.variant === "ghost" ? ghostStyle : primaryStyle),
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const buttonBase: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
  border: "none",
  transition: "background 0.15s, opacity 0.15s",
};

const primaryStyle: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--text-on-accent)",
  border: "1px solid var(--accent)",
};

const dangerStyle: React.CSSProperties = {
  background: "var(--danger-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--danger-color)",
};

const ghostStyle: React.CSSProperties = {
  background: "var(--state-hover)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
};
