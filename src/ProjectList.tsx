import { useEffect, useMemo, useState, useCallback } from "react";
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
import { sessionBelongsToProject } from "./mobile/mobile-selectors.ts";
import { useSessionActivity } from "./use-session-activity.ts";
import { useSocket, type SessionInfo } from "./use-socket.ts";
import { buildWsUrl } from "./ws-url.ts";
import {
  ArrowRight,
  Clock3,
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import "./project-list.css";

const log = browserLogger.child("project-list");
const WS_URL = buildWsUrl();

function countRunningSessions(
  sessions: SessionInfo[],
  projectPath: string,
  projectId: string,
): number {
  return sessions.filter(
    (session) =>
      session.role !== "minion" &&
      sessionBelongsToProject(session, projectPath, projectId) &&
      (session.status === "running" || session.status === "creating"),
  ).length;
}

interface ProjectListProps {
  onOpenProject: (id: string, projectPath: string) => void;
}

export function ProjectList({ onOpenProject }: ProjectListProps) {
  const socket = useSocket(WS_URL);
  const { sessions } = useSessionActivity(socket.subscribe);
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

  useEffect(() => {
    if (!socket.connected) return;
    socket.send({ type: "list_sessions" });
  }, [socket.connected, socket.send]);

  const runningSessionsByProject = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.id,
          countRunningSessions(sessions, project.path, project.id),
        ]),
      ),
    [projects, sessions],
  );

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
    <main className="project-list-page">
      <div className="project-list-shell">
        <header className="project-list-header">
          <div className="project-list-brand" role="img" aria-label="Minions">
            <span
              className="project-list-brand__layer project-list-brand__base"
              aria-hidden="true"
            />
            <span
              className="project-list-brand__layer project-list-brand__crown"
              aria-hidden="true"
            />
          </div>
          <div className="project-list-heading">
            <span>Workspace</span>
            <h1>Projects</h1>
            <p>Open a folder to resume your canvas, or create a new project.</p>
          </div>
        </header>

        <section className="project-list-card" aria-labelledby="project-action-title">
          <div className="project-list-card__heading">
            <span className="project-list-card__icon" aria-hidden="true">
              {mode === "open" ? <FolderOpen size={15} /> : <Plus size={15} />}
            </span>
            <div>
              <h2 id="project-action-title">
                {mode === "open" ? "Open a workspace" : "Create a workspace"}
              </h2>
              <p>
                {mode === "open"
                  ? "Choose an existing repository to continue where you left off."
                  : "Start a fresh Minions canvas in a local repository."}
              </p>
            </div>
          </div>

          <div className="project-list-card__body">
            <div className="project-list-mode" role="group" aria-label="Project action">
              <button
                type="button"
                aria-pressed={mode === "open"}
                onClick={() => setMode("open")}
              >
                <FolderOpen size={13} aria-hidden="true" />
                Open Folder
              </button>
              <button
                type="button"
                aria-pressed={mode === "create"}
                onClick={() => setMode("create")}
              >
                <Plus size={13} aria-hidden="true" />
                New Project
              </button>
            </div>

            <div className="project-list-fields">
              <label className="project-list-field">
                <span>Repository path</span>
                <input
                  type="text"
                  placeholder={mode === "open" ? "/path/to/existing/project..." : "/path/to/new/project..."}
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void (mode === "open" ? handleOpen() : handleCreate());
                  }}
                />
              </label>
              {mode === "create" && (
                <label className="project-list-field">
                  <span>Project name</span>
                  <input
                    type="text"
                    placeholder="Project name (optional, defaults to folder name)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </label>
              )}
              <button
                type="button"
                className="project-list-primary-action"
                onClick={() => void (mode === "open" ? handleOpen() : handleCreate())}
                disabled={projectActionDisabled}
              >
                {creating ? "Opening..." : mode === "open" ? "Open" : "Create"}
                {!creating && <ArrowRight size={14} aria-hidden="true" />}
              </button>
            </div>

            {readiness?.ready === false && (
              <div role="alert" className="project-list-alert">
                <span>Sign in to Claude or Codex to open or create a project.</span>
                <button
                  type="button"
                  onClick={() => void retryReadiness()}
                  disabled={checkingReadiness}
                >
                  <RefreshCw size={12} aria-hidden="true" />
                  {checkingReadiness ? "Checking…" : "Check again"}
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="project-list-card" aria-labelledby="recent-projects-title">
          <div className="project-list-card__heading project-list-card__heading--split">
            <div className="project-list-card__heading-copy">
              <span className="project-list-card__icon" aria-hidden="true">
                <Clock3 size={15} />
              </span>
              <div>
                <h2 id="recent-projects-title">Recent projects</h2>
                <p>Jump back into a canvas from this machine.</p>
              </div>
            </div>
            {!loading && projects.length > 0 && (
              <span className="project-list-count">{projects.length}</span>
            )}
          </div>

          <div className="project-list-card__body">
            {loading ? (
              <div className="project-list-state project-list-state--loading">Loading...</div>
            ) : projects.length === 0 ? (
              <div className="project-list-state">
                <strong>No recent projects</strong>
                <p>Open a folder to get started.</p>
                <small>
                  Worktree isolation is optional, merges require approval, and Minions keeps project state in its private workspace home.
                  A safe first task is: “Summarize this repository’s structure without changing files.”
                </small>
              </div>
            ) : (
              <div className="project-list-recents">
                {projects.map((p) => {
                  const runningSessions = runningSessionsByProject.get(p.id) ?? 0;
                  const hasRunningSessions = runningSessions > 0;
                  const runningLabel = `${runningSessions} running ${runningSessions === 1 ? "session" : "sessions"}`;

                  return (
                    <div
                      className="project-list-recent"
                      key={p.id}
                      onClick={() => onOpenProject(p.id, p.path)}
                    >
                      <span
                        className={`project-list-recent__activity ${hasRunningSessions ? "project-list-recent__activity--active" : "project-list-recent__activity--sleeping"}`}
                        role="img"
                        aria-label={hasRunningSessions ? `${p.name} has ${runningLabel}` : `${p.name} is sleeping with no running sessions`}
                      >
                        {hasRunningSessions ? (
                          <img src="/icons/minion.svg" alt="" aria-hidden="true" />
                        ) : (
                          <span className="project-list-recent__zzz" aria-hidden="true">ZZZ</span>
                        )}
                      </span>
                      <div className="project-list-recent__details">
                        <strong>{p.name}</strong>
                        <span className={`project-list-recent__session-count ${hasRunningSessions ? "project-list-recent__session-count--active" : ""}`}>
                          {runningLabel}
                        </span>
                        <span className="project-list-recent__path">{p.path}</span>
                        <small>
                          {formatDate(p.lastOpened)}
                          {!p.hasSidecar && <em>No canvas data</em>}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="project-list-remove"
                        aria-label="Remove"
                        title="Remove from recent projects"
                        onClick={(e) => void handleRemoveRecent(e, p.id)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        <span>Remove</span>
                      </button>
                      <ArrowRight className="project-list-recent__arrow" size={14} aria-hidden="true" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
