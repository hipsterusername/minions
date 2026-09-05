import { useState, useRef, useEffect } from "react";
import { Activity, Bot, Check, ChevronDown, FolderKanban, LayoutGrid, Pencil } from "lucide-react";
import type { SaveStatus } from "./use-autosave.ts";
import { listProjects, type ProjectSettings, type ProjectSummary } from "./api.ts";
import { SettingsMenu } from "./SettingsMenu.tsx";
import type { SessionInfo, SocketSubscribe } from "./use-socket.ts";
import { sessionBelongsToProject, sessionDisplayTitle } from "./mobile/mobile-selectors.ts";
import type { SettingsSaveState } from "./ContextActionsSettings.tsx";
import "./project-header.css";

export type ActiveView = "activity" | "canvas";

const ACTIVE_SESSION_LABELS: Record<string, string> = {
  running: "Working",
  creating: "Starting",
  starting: "Starting",
  waiting: "Waiting",
};

function ProjectMinionPreview({ project, sessions }: {
  project: ProjectSummary;
  sessions: SessionInfo[];
}) {
  const workspaceId = project.workspaceId ?? project.id;
  const active = sessions.filter((session) =>
    Object.hasOwn(ACTIVE_SESSION_LABELS, session.status) &&
    (session.projectId
      ? session.projectId === workspaceId
      : sessionBelongsToProject(session, project.sourceRoot ?? project.path, workspaceId)),
  );
  if (active.length === 0) return null;

  return (
    <span className="project-switcher__preview">
      <span className="project-switcher__preview-heading">
        <Bot size={12} aria-hidden="true" />
        {active.length} active
      </span>
      {active.slice(0, 3).map((session) => (
        <span className="project-switcher__minion" key={session.sessionKey}
          title={`${sessionDisplayTitle(session)} · ${ACTIVE_SESSION_LABELS[session.status]}`}>
          <span className="project-switcher__minion-dot" data-status={session.status} aria-hidden="true" />
          <span className="project-switcher__minion-name">{sessionDisplayTitle(session)}</span>
          <span className="project-switcher__minion-status">{ACTIVE_SESSION_LABELS[session.status]}</span>
        </span>
      ))}
      {active.length > 3 ? (
        <span className="project-switcher__preview-more">+{active.length - 3} more</span>
      ) : null}
    </span>
  );
}

interface ProjectHeaderProps {
  projectId: string;
  name: string;
  saveStatus: SaveStatus;
  lastSaved: Date | null;
  onRename: (name: string) => void;
  onBack: () => void;
  onSwitchProject: (id: string, path: string) => void;
  /** Live sessions across all workspaces, including delegated minions. */
  sessions?: SessionInfo[];
  retryCount?: number;
  retry?: () => void;
  activeView: ActiveView;
  onViewChange: (view: ActiveView) => void;
  /**
   * Number of sessions needing attention (includes sessions with pending
   * worktree changes) — shows a badge on the Activity tab.
   */
  activityAttentionCount?: number;
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
  settingsSaveState?: SettingsSaveState;
  onRetrySettingsSave?: () => void;
  socketSend?: (data: unknown) => void;
  socketSubscribe?: SocketSubscribe;
}

export function ProjectHeader({
  projectId,
  name,
  saveStatus,
  lastSaved,
  onRename,
  onBack,
  onSwitchProject,
  sessions = [],
  retryCount = 0,
  retry,
  activeView,
  onViewChange,
  activityAttentionCount = 0,
  settings,
  onSettingsChange,
  settingsSaveState,
  onRetrySettingsSave,
  socketSend,
  socketSubscribe,
}: ProjectHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const switcherButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!switcherOpen) return;

    let cancelled = false;
    setProjectsLoading(true);
    setProjectsError(false);
    void listProjects()
      .then((nextProjects) => {
        if (!cancelled) setProjects(nextProjects);
      })
      .catch(() => {
        if (!cancelled) setProjectsError(true);
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [switcherOpen]);

  useEffect(() => {
    if (!switcherOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSwitcherOpen(false);
      switcherButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [switcherOpen]);

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
        // Keep header menus above canvas overlays (850–900), below dialogs (1000+).
        zIndex: 950,
        gap: 12,
      }}
    >
      <button
        type="button"
        className="project-header-logo"
        onClick={onBack}
        aria-label="All projects"
        title="All projects"
      >
        <span className="project-header-logo__layer project-header-logo__base" aria-hidden="true" />
        <span className="project-header-logo__layer project-header-logo__crown" aria-hidden="true" />
      </button>

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
        <div className="project-switcher" ref={switcherRef}>
          <button
            ref={switcherButtonRef}
            type="button"
            className="project-switcher__trigger"
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((open) => !open)}
          >
            <span className="project-switcher__name">{name}</span>
            <ChevronDown
              className="project-switcher__chevron"
              data-open={switcherOpen || undefined}
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>

          {switcherOpen ? (
            <div className="project-switcher__menu" role="menu" aria-label="Switch project">
              <div className="project-switcher__label">Projects</div>
              <div className="project-switcher__list">
                {projectsLoading && projects.length === 0 ? (
                  <div className="project-switcher__state" role="status">Loading projects…</div>
                ) : null}
                {projectsError ? (
                  <div className="project-switcher__state" role="alert">Couldn’t load projects</div>
                ) : null}
                {!projectsLoading && !projectsError && projects.length === 0 ? (
                  <div className="project-switcher__state">No other projects</div>
                ) : null}
                {projects.map((project) => {
                  const current = project.id === projectId;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className="project-switcher__project"
                      role="menuitemradio"
                      aria-checked={current}
                      title={project.path}
                      onClick={() => {
                        setSwitcherOpen(false);
                        if (!current) onSwitchProject(project.id, project.path);
                      }}
                    >
                      <span className="project-switcher__project-copy">
                        <span className="project-switcher__project-name">
                          {current ? name : project.name}
                        </span>
                        <span className="project-switcher__project-path">{project.path}</span>
                        <ProjectMinionPreview project={project} sessions={sessions} />
                      </span>
                      {current ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>

              <div className="project-switcher__actions">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSwitcherOpen(false);
                    setEditValue(name);
                    setEditing(true);
                  }}
                >
                  <Pencil size={13} aria-hidden="true" />
                  Rename project
                </button>
                <button type="button" role="menuitem" onClick={onBack}>
                  <FolderKanban size={13} aria-hidden="true" />
                  View all projects
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

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
      </div>

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

      <SettingsMenu
        settings={settings}
        onSettingsChange={onSettingsChange}
        settingsSaveState={settingsSaveState}
        onRetrySettingsSave={onRetrySettingsSave}
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
            color: "var(--text-on-status)",
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
