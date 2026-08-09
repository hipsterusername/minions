import { useEffect, useMemo, useState } from "react";

import { createProject, getHarnessReadiness, listProjects, type HarnessReadinessSnapshot, type ProjectSummary } from "../api.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";
import { needsAttention, sessionBelongsToProject } from "./mobile-selectors.ts";

interface ProjectsScreenProps {
  sessions: MobileSessionInfo[];
  onSelectProject: (project: ProjectSummary) => void;
}

interface ProjectStats {
  count: number;
  running: number;
  attention: number;
  cost: number;
}

function statsForProject(
  sessions: MobileSessionInfo[],
  projectPath: string,
  projectId: string,
): ProjectStats {
  let count = 0;
  let running = 0;
  let attention = 0;
  let cost = 0;
  for (const session of sessions) {
    if (session.role === "minion") continue;
    if (!sessionBelongsToProject(session, projectPath, projectId)) continue;
    count += 1;
    if (session.status === "running" || session.status === "creating") running += 1;
    if (needsAttention(session)) attention += 1;
    if (session.totalCost != null && Number.isFinite(session.totalCost)) {
      cost += session.totalCost;
    }
  }
  return { count, running, attention, cost };
}

function formatProjectStats(stats: ProjectStats): string {
  const parts = stats.running > 0
    ? [`▶ ${stats.running} running`]
    : [stats.count === 1 ? "1 session" : `${stats.count} sessions`];
  parts.push(`$${stats.cost.toFixed(2)}`);
  if (stats.attention > 0) parts.push(`⚠ ${stats.attention} needs you`);
  return parts.join(" · ");
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
  }

  async function handleCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedPath = projectPath.trim();
    if (!trimmedPath || creating) return;

    setCreating(true);
    setCreateError(null);
    try {
      const created = await createProject(projectName.trim() || "Untitled", trimmedPath);
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
              onChange={(event) => setProjectPath(event.currentTarget.value)}
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
              onChange={(event) => setProjectName(event.currentTarget.value)}
              placeholder="Untitled"
            />
          </label>
          {createError ? <div className="mob-launch-error" role="alert">{createError}</div> : null}
          <div className="mob-project-create-actions">
            <button className="mob-header-action" type="button" onClick={closeCreateForm}>
              Cancel
            </button>
            <button
              className="mob-launch-submit"
              type="submit"
              disabled={creating || !projectPath.trim() || readiness?.ready === false}
            >
              {creating ? "Creating..." : "Create project"}
            </button>
          </div>
        </form>
      ) : null}

      {loading ? <div className="mob-launch-status">Loading projects...</div> : null}
      {error ? <div className="mob-launch-error" role="alert">{error}</div> : null}
      {!loading && !error && projects.length === 0 ? (
        <p className="mob-muted">No recent projects found.</p>
      ) : null}

      <div className="mob-project-list">
        {projects.map((project) => {
          const stat = stats.get(project.id) ?? { count: 0, running: 0, attention: 0, cost: 0 };
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
                {formatProjectStats(stat)}
              </span>
            </button>
          );
        })}
      </div>
    </main>
  );
}
