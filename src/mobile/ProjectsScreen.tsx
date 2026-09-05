import { MinionsIcon } from "../components/MinionsIcon.tsx";
import { useEffect, useMemo, useState } from "react";

import {
  checkProjectGit,
  createProject,
  getHarnessReadiness,
  listProjects,
  type HarnessReadinessSnapshot,
  type ProjectGitAction,
  type ProjectSummary,
} from "../api.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";
import { needsAttention, sessionBelongsToProject } from "./mobile-selectors.ts";
import { ProjectGitWarning } from "../ProjectGitWarning.tsx";

interface ProjectsScreenProps {
  sessions: MobileSessionInfo[];
  onSelectProject: (project: ProjectSummary) => void;
}

interface ProjectStats {
  count: number;
  active: number;
  attention: number;
  cost: number;
}

function statsForProject(
  sessions: MobileSessionInfo[],
  projectPath: string,
  projectId: string,
): ProjectStats {
  let count = 0;
  let active = 0;
  let attention = 0;
  let cost = 0;
  for (const session of sessions) {
    if (session.role === "minion") continue;
    if (!sessionBelongsToProject(session, projectPath, projectId)) continue;
    count += 1;
    if (session.status === "running" || session.status === "creating" || session.status === "waiting") active += 1;
    if (needsAttention(session)) attention += 1;
    if (session.totalCost != null && Number.isFinite(session.totalCost)) {
      cost += session.totalCost;
    }
  }
  return { count, active, attention, cost };
}

function ProjectStatsSummary({ stats }: { stats: ProjectStats }) {
  return (
    <>
      {stats.active > 0 ? (
        <><MinionsIcon name="play" size={12} /> {stats.active} active</>
      ) : (stats.count === 1 ? "1 session" : `${stats.count} sessions`)}
      {` · $${stats.cost.toFixed(2)}`}
      {stats.attention > 0 && (
        <> · <MinionsIcon name="warning" size={12} /> {stats.attention} needs you</>
      )}
    </>
  );
}

export function ProjectsScreen({ sessions, onSelectProject }: ProjectsScreenProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<HarnessReadinessSnapshot | null>(null);
  const [pendingGitDecision, setPendingGitDecision] = useState<{ name: string; path: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    void listProjects()
      .then((result) => {
        if (cancelled) return;
        setProjects(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    void getHarnessReadiness().then((value) => { if (!cancelled) setReadiness(value); });

    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => {
    const map = new Map<string, ProjectStats>();
    for (const project of projects) {
      map.set(project.id, statsForProject(sessions, project.path, project.id));
    }
    return map;
  }, [projects, sessions]);

  function closeCreateForm() {
    if (creating) return;
    setShowCreateForm(false);
    setProjectPath("");
    setProjectName("");
    setCreateError(null);
    setPendingGitDecision(null);
  }

  async function finishCreateProject(
    project: { name: string; path: string },
    gitAction?: ProjectGitAction,
  ) {
    setCreating(true);
    setCreateError(null);
    try {
      const created = gitAction
        ? await createProject(project.name, project.path, gitAction)
        : await createProject(project.name, project.path);
      onSelectProject({
        id: created.id,
        path: created.path,
        name: created.name,
        lastOpened: created.updatedAt,
        hasSidecar: true,
      });
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedPath = projectPath.trim();
    if (!trimmedPath || creating) return;

    const project = { name: projectName.trim() || "Untitled", path: trimmedPath };
    setCreating(true);
    setCreateError(null);
    setPendingGitDecision(null);
    try {
      const status = await checkProjectGit(project.path);
      if (!status.isRepository) {
        setPendingGitDecision(project);
        return;
      }
      await finishCreateProject(project);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to check project Git status");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="mob-screen mob-projects" aria-label="Projects">
      <header className="mob-screen-header">
        <h1>Projects</h1>
        <div className="mob-project-header-actions">
          {projects.length > 0 ? <span className="mob-count">{projects.length}</span> : null}
          <button
            type="button"
            className="mob-header-action"
            onClick={() => {
              setShowCreateForm(true);
              setCreateError(null);
            }}
            aria-expanded={showCreateForm}
          >
            New project
          </button>
        </div>
      </header>

      {showCreateForm ? (
        <form className="mob-project-create" onSubmit={handleCreateProject}>
          <div className="mob-muted">{readiness?.harnesses.map((h) => `${h.name}: ${h.ready ? "Ready" : h.state.replaceAll("_", " ")}`).join(" · ")}</div>
          <label className="mob-launch-field">
            <span>Project path</span>
            <input
              type="text"
              value={projectPath}
              onChange={(event) => {
                setProjectPath(event.currentTarget.value);
                setPendingGitDecision(null);
              }}
              placeholder="/path/to/new/project"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </label>
          <label className="mob-launch-field">
            <span>Name</span>
            <input
              type="text"
              value={projectName}
              onChange={(event) => {
                setProjectName(event.currentTarget.value);
                setPendingGitDecision(null);
              }}
              placeholder="Untitled"
            />
          </label>
          {pendingGitDecision ? (
            <ProjectGitWarning
              busy={creating}
              variant="mobile"
              onContinue={() => void finishCreateProject(pendingGitDecision, "continue_without_git")}
              onInitialize={() => void finishCreateProject(pendingGitDecision, "initialize")}
            />
          ) : null}
          {createError ? <div className="mob-launch-error" role="alert">{createError}</div> : null}
          <div className="mob-project-create-actions">
            <button className="mob-header-action" type="button" onClick={closeCreateForm}>
              Cancel
            </button>
            <button
              className="mob-launch-submit"
              type="submit"
              disabled={creating || !projectPath.trim() || readiness?.ready === false || pendingGitDecision !== null}
            >
              {creating ? "Creating..." : "Create project"}
            </button>
          </div>
        </form>
      ) : null}

      {loading ? <div className="mob-launch-status">Loading projects...</div> : null}
      {error ? <div className="mob-launch-error" role="alert">{error}</div> : null}
      {!loading && !error && projects.length === 0 ? (
        <div className="mob-empty mob-empty--surface">
          <h2>Start with a project</h2>
          <p><span>No recent projects found.</span> Create one to launch and monitor Leaders from your phone.</p>
        </div>
      ) : null}

      <div className="mob-project-list">
        {projects.map((project) => {
          const stat = stats.get(project.id) ?? { count: 0, active: 0, attention: 0, cost: 0 };
          return (
            <button
              className={`mob-project-card${stat.attention > 0 ? " mob-project-card--attention" : ""}`}
              key={project.id}
              type="button"
              onClick={() => onSelectProject(project)}
            >
              <span className="mob-project-name">{project.name}</span>
              <span className="mob-project-path">{project.path}</span>
              <span className="mob-project-meta">
                <ProjectStatsSummary stats={stat} />
              </span>
            </button>
          );
        })}
      </div>
    </main>
  );
}
