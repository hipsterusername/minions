import { useEffect, useRef } from "react";

export interface ContextMenuOption {
  label: string;
  type: string;
}

interface CanvasContextMenuProps {
  x: number;
  y: number;
  options: ContextMenuOption[];
  onSelect: (type: string) => void;
  onClose: () => void;
  title?: string;
}

export function CanvasContextMenu({
  x,
  y,
  options,
  onSelect,
  onClose,
  title = "Add node",
}: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Use a rAF so the opening right-click doesn't immediately close it
    const id = requestAnimationFrame(() => {
      window.addEventListener("mousedown", handleMouseDown);
      window.addEventListener("keydown", handleKeyDown);
    });
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Adjust position if menu would overflow viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const el = menuRef.current;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      el.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 500,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 8,
        padding: 4,
        minWidth: 180,
        boxShadow: "var(--shadow-md)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
      }}
    >
      <div
        style={{
          padding: "4px 10px 6px",
          fontSize: 11,
          color: "var(--text-muted)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          userSelect: "none",
        }}
      >
        {title}
      </div>
      {options.map((opt) => (
        <button
          key={opt.type}
          onClick={() => {
            onSelect(opt.type);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            padding: "7px 10px",
            background: "transparent",
            border: "none",
            color: "var(--text-primary)",
            fontSize: 13,
            cursor: "pointer",
            textAlign: "left",
            borderRadius: 5,
            fontFamily: "var(--font-mono)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "transparent";
          }}
        >
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
