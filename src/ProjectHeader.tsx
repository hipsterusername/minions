import { useState, useRef, useEffect } from "react";
import type { SaveStatus } from "./use-autosave.ts";

interface ProjectHeaderProps {
  name: string;
  saveStatus: SaveStatus;
  lastSaved: Date | null;
  onRename: (name: string) => void;
  onBack: () => void;
  retryCount?: number;
  retry?: () => void;
}

export function ProjectHeader({
  name,
  saveStatus,
  lastSaved,
  onRename,
  onBack,
  retryCount = 0,
  retry,
}: ProjectHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name) {
      onRename(trimmed);
    } else {
      setEditValue(name);
    }
    setEditing(false);
  };

  const statusLabel = () => {
    switch (saveStatus) {
      case "saving":
        return retryCount > 0 ? `Retrying... (attempt ${retryCount + 1})` : "Saving...";
      case "saved":
        if (lastSaved) {
          const secs = Math.floor(
            (Date.now() - lastSaved.getTime()) / 1000,
          );
          if (secs < 5) return "Saved";
          if (secs < 60) return `Saved ${secs}s ago`;
          return `Saved ${Math.floor(secs / 60)}m ago`;
        }
        return "Saved";
      case "unsaved":
        return "Unsaved";
      case "error":
        return "Save failed · Click to retry";
      case "idle":
        return "";
    }
  };

  const statusColor = () => {
    switch (saveStatus) {
      case "saving":
        return "var(--text-muted)";
      case "saved":
        return "#4ade80";
      case "unsaved":
        return "var(--accent)";
      case "error":
        return "#ef4444";
      case "idle":
        return "var(--text-muted)";
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 44,
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-default)",
        zIndex: 200,
        gap: 12,
      }}
    >
      {/* Back button */}
      <button
        onClick={onBack}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 10px",
          fontSize: 12,
          background: "transparent",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          color: "var(--text-secondary)",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.borderColor = "var(--border-hover)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.borderColor = "var(--border-default)")
        }
      >
        <span style={{ fontSize: 14 }}>&larr;</span> Projects
      </button>

      {/* Project name */}
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setEditValue(name);
              setEditing(false);
            }
          }}
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: "var(--text-primary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--accent)",
            borderRadius: 4,
            padding: "2px 8px",
            fontFamily: "var(--font-sans)",
            outline: "none",
            minWidth: 120,
          }}
        />
      ) : (
        <span
          onClick={() => {
            setEditValue(name);
            setEditing(true);
          }}
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: "var(--text-primary)",
            cursor: "pointer",
            padding: "2px 8px",
            borderRadius: 4,
            fontFamily: "var(--font-sans)",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "var(--bg-surface)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
          title="Click to rename"
        >
          {name}
        </span>
      )}

      {/* Save status */}
      <div
        onClick={saveStatus === "error" && retry ? () => retry() : undefined}
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 6,
          cursor: saveStatus === "error" && retry ? "pointer" : "default",
          background:
            saveStatus === "error"
              ? "rgba(239, 68, 68, 0.1)"
              : "transparent",
          border:
            saveStatus === "error"
              ? "1px solid rgba(239, 68, 68, 0.25)"
              : "1px solid transparent",
          transition: "background 0.2s, border-color 0.2s",
        }}
      >
        {saveStatus !== "idle" && (
          <>
            <div
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: statusColor(),
                boxShadow:
                  saveStatus === "saved"
                    ? `0 0 4px ${statusColor()}`
                    : "none",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: statusColor(),
                fontFamily: "var(--font-mono)",
                letterSpacing: 0.5,
                userSelect: "none",
              }}
            >
              {statusLabel()}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
