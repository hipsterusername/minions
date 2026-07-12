import { useEffect, useState, useCallback } from "react";
import {
  listProjects,
  createProject,
  openProject,
  deleteProject,
  getHarnessReadiness,
  type ProjectSummary,
  type HarnessReadinessSnapshot,
} from "./api.ts";
import { browserLogger } from "./logging.ts";

const log = browserLogger.child("project-list");

interface ProjectListProps {
  onOpenProject: (id: string, projectPath: string) => void;
}

export function ProjectList({ onOpenProject }: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [folderPath, setFolderPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<"open" | "create">("open");
  const [newName, setNewName] = useState("");
  const [readiness, setReadiness] = useState<HarnessReadinessSnapshot | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [projectsResult, readinessResult] = await Promise.allSettled([
      listProjects(),
      getHarnessReadiness(),
    ]);
    if (projectsResult.status === "fulfilled") setProjects(projectsResult.value);
    else log.error("projects_load_failed", { error: projectsResult.reason });
    if (readinessResult.status === "fulfilled") setReadiness(readinessResult.value);
    else log.warn("harness_readiness_load_failed", { error: readinessResult.reason });
    setLoading(false);
  }, []);

  const retryReadiness = useCallback(async () => {
    setCheckingReadiness(true);
    try {
      setReadiness(await getHarnessReadiness(true));
    } catch (err) {
      log.warn("harness_readiness_retry_failed", { error: err });
    } finally {
      setCheckingReadiness(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleOpen = async () => {
    const p = folderPath.trim();
    if (!p) return;
    setCreating(true);
    try {
      const project = await openProject(p);
      onOpenProject(project.id, project.path);
    } catch (err) {
      log.error("project_open_failed", { error: err });
      alert(`Failed to open project: ${err}`);
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async () => {
    const p = folderPath.trim();
    if (!p) return;
    setCreating(true);
    try {
      const name = newName.trim() || undefined;
      const project = await createProject(name ?? "Untitled", p);
      onOpenProject(project.id, project.path);
    } catch (err) {
      log.error("project_create_failed", { error: err });
      alert(`Failed to create project: ${err}`);
    } finally {
      setCreating(false);
    }
  };

  const handleRemoveRecent = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      log.error("project_remove_failed", { error: err });
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  };

  const projectActionDisabled = creating || !folderPath.trim() || readiness?.ready === false;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "var(--bg-primary)",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          maxWidth: 640,
          width: "100%",
          padding: "80px 24px 48px",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: 48 }}>
          <h1
            style={{
              fontSize: 28,
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: 8,
              fontFamily: "var(--font-sans)",
            }}
          >
            Projects
          </h1>
          <p
            style={{
              fontSize: 14,
              color: "var(--text-muted)",
              fontFamily: "var(--font-sans)",
            }}
          >
            Open a folder to resume your canvas, or create a new project.
          </p>
        </div>

        {/* Mode toggle */}
        <div
          style={{
            display: "flex",
            gap: 4,
            marginBottom: 16,
            background: "var(--bg-secondary)",
            borderRadius: 8,
            padding: 3,
            width: "fit-content",
          }}
        >
          <button
            onClick={() => setMode("open")}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              fontWeight: 500,
              background: mode === "open" ? "var(--bg-elevated)" : "transparent",
              border: "none",
              borderRadius: 6,
              color: mode === "open" ? "var(--text-primary)" : "var(--text-muted)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Open Folder
          </button>
          <button
            onClick={() => setMode("create")}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              fontWeight: 500,
              background: mode === "create" ? "var(--bg-elevated)" : "transparent",
              border: "none",
              borderRadius: 6,
              color: mode === "create" ? "var(--text-primary)" : "var(--text-muted)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            New Project
          </button>
        </div>

        {/* Folder path input */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: mode === "create" ? 8 : 0 }}>
            <input
              type="text"
              placeholder={mode === "open" ? "/path/to/existing/project..." : "/path/to/new/project..."}
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void (mode === "open" ? handleOpen() : handleCreate());
              }}
              style={{
                flex: 1,
                padding: "10px 14px",
                fontSize: 14,
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                borderRadius: 8,
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
            />
            <button
              onClick={() => void (mode === "open" ? handleOpen() : handleCreate())}
              disabled={projectActionDisabled}
              style={{
                padding: "10px 20px",
                fontSize: 14,
                fontWeight: 500,
                background: projectActionDisabled ? "var(--bg-elevated)" : "var(--accent)",
                color: projectActionDisabled ? "var(--text-muted)" : "var(--text-primary)",
                border: "none",
                borderRadius: 8,
                cursor: projectActionDisabled ? "not-allowed" : "pointer",
                fontFamily: "var(--font-sans)",
                opacity: creating ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {creating ? "Opening..." : mode === "open" ? "Open" : "Create"}
            </button>
          </div>
          {mode === "create" && (
            <input
              type="text"
              placeholder="Project name (optional, defaults to folder name)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 14px",
                fontSize: 14,
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                borderRadius: 8,
                color: "var(--text-primary)",
                fontFamily: "var(--font-sans)",
                outline: "none",
              }}
            />
          )}
          {readiness?.ready === false && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                marginTop: 12,
                padding: "10px 12px",
                border: "1px solid var(--warning-color)",
                borderRadius: 8,
                background: "var(--bg-surface)",
                color: "var(--text-secondary)",
                fontSize: 12,
              }}
            >
              <span>Sign in to Claude or Codex to open or create a project.</span>
              <button
                type="button"
                onClick={() => void retryReadiness()}
                disabled={checkingReadiness}
                style={{
                  flexShrink: 0,
                  padding: "5px 9px",
                  border: "1px solid var(--border-default)",
                  borderRadius: 6,
                  background: "var(--bg-elevated)",
                  color: "var(--text-primary)",
                  cursor: checkingReadiness ? "wait" : "pointer",
                  fontSize: 12,
                  fontFamily: "var(--font-sans)",
                }}
              >
                {checkingReadiness ? "Checking…" : "Check again"}
              </button>
            </div>
          )}
        </div>

        {/* Recent projects list */}
        <div style={{ marginBottom: 16 }}>
          <h2
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 1,
              fontFamily: "var(--font-mono)",
              marginBottom: 12,
            }}
          >
            Recent Projects
          </h2>
        </div>

        {loading ? (
          <div
            style={{
              textAlign: "center",
              padding: 48,
              color: "var(--text-muted)",
              fontSize: 14,
              fontFamily: "var(--font-mono)",
            }}
          >
            Loading...
          </div>
        ) : projects.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: 48,
              color: "var(--text-muted)",
              fontSize: 14,
            }}
          >
            <div>No recent projects. Open a folder to get started.</div>
            <div style={{ marginTop: 12, lineHeight: 1.6 }}>
              Worktree isolation is optional, merges require approval, and project data lives under <code>.minions/</code>.
              A safe first task is: “Summarize this repository’s structure without changing files.”
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {projects.map((p) => (
              <div
                key={p.id}
                onClick={() => onOpenProject(p.id, p.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 20px",
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 10,
                  cursor: "pointer",
                  transition: "border-color 0.15s, background 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-hover)";
                  e.currentTarget.style.background = "var(--bg-elevated)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-default)";
                  e.currentTarget.style.background = "var(--bg-surface)";
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 500,
                      color: "var(--text-primary)",
                      marginBottom: 4,
                    }}
                  >
                    {p.name}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.path}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                      marginTop: 2,
                    }}
                  >
                    {formatDate(p.lastOpened)}
                    {!p.hasSidecar && (
                      <span style={{ color: "var(--warning-color)", marginLeft: 8 }}>
                        No canvas data
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => void handleRemoveRecent(e, p.id)}
                  style={{
                    padding: "6px 10px",
                    fontSize: 11,
                    background: "transparent",
                    border: "1px solid var(--border-default)",
                    borderRadius: 6,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    flexShrink: 0,
                    marginLeft: 12,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--danger-color)";
                    e.currentTarget.style.color = "var(--danger-color)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-default)";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
