import { useState, useRef, useEffect } from "react";
import { Activity, LayoutGrid, Columns3 } from "lucide-react";
import type { SaveStatus } from "./use-autosave.ts";
import type { ProjectSettings } from "./api.ts";
import { SettingsMenu } from "./SettingsMenu.tsx";
import type { SocketSubscribe } from "./use-socket.ts";

export type ActiveView = "activity" | "canvas" | "kanban";

interface ProjectHeaderProps {
  name: string;
  saveStatus: SaveStatus;
  lastSaved: Date | null;
  onRename: (name: string) => void;
  onBack: () => void;
  retryCount?: number;
  retry?: () => void;
  activeView: ActiveView;
  onViewChange: (view: ActiveView) => void;
  /** Number of cards blocked/needing attention — shows a badge on the Kanban tab */
  kanbanBlockedCount?: number;
  /**
   * Number of sessions needing attention (includes sessions with pending
   * worktree changes) — shows a badge on the Activity tab.
   */
  activityAttentionCount?: number;
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
  socketSend?: (data: unknown) => void;
  socketSubscribe?: SocketSubscribe;
}

export function ProjectHeader({
  name,
  saveStatus,
  lastSaved,
  onRename,
  onBack,
  retryCount = 0,
  retry,
  activeView,
  onViewChange,
  kanbanBlockedCount = 0,
  activityAttentionCount = 0,
  settings,
  onSettingsChange,
  socketSend,
  socketSubscribe,
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
        return "Save failed \u00b7 Click to retry";
      case "idle":
        return "";
    }
  };

  const statusColor = () => {
    switch (saveStatus) {
      case "saving":
        return "var(--text-muted)";
      case "saved":
        return "var(--success-color)";
      case "unsaved":
        return "var(--accent)";
      case "error":
        return "var(--danger-color)";
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

      {/* ─── View Toggle ─────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          padding: 2,
          gap: 2,
        }}
        role="tablist"
        aria-label="View mode"
      >
        <ViewTab
          label="Activity"
          active={activeView === "activity"}
          onClick={() => onViewChange("activity")}
          badge={activityAttentionCount > 0 ? activityAttentionCount : undefined}
          icon={<Activity size={12} strokeWidth={1.75} aria-hidden />}
        />
        <ViewTab
          label="Canvas"
          active={activeView === "canvas"}
          onClick={() => onViewChange("canvas")}
          icon={<LayoutGrid size={12} strokeWidth={1.75} aria-hidden />}
        />
        <ViewTab
          label="Kanban"
          active={activeView === "kanban"}
          onClick={() => onViewChange("kanban")}
          badge={kanbanBlockedCount > 0 ? kanbanBlockedCount : undefined}
          icon={<Columns3 size={12} strokeWidth={1.75} aria-hidden />}
        />
      </div>

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
              ? "var(--danger-bg)"
              : "transparent",
          border:
            saveStatus === "error"
              ? "1px solid var(--danger-color)"
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

      {/* Settings (top right) */}
      <SettingsMenu
        settings={settings}
        onSettingsChange={onSettingsChange}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
      />
    </div>
  );
}

// ─── View Tab ───────────────────────────────────────────────

function ViewTab({
  label,
  active,
  onClick,
  icon,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: number | undefined;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 12px",
        fontSize: 11,
        fontFamily: "var(--font-sans)",
        fontWeight: active ? 600 : 500,
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--bg-elevated)" : "transparent",
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        transition: "background 120ms ease, color 120ms ease",
        position: "relative",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-surface)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {icon}
      {label}
      {badge != null && badge > 0 && (
        <span
          style={{
            minWidth: 16,
            height: 16,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 5px",
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            color: "var(--text-primary)",
            background: "var(--danger-color)",
            borderRadius: 8,
            lineHeight: 1,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
