import { useEffect, useMemo, useState } from "react";

import { createProject, listProjects, type ProjectSummary } from "../api.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";
import { needsAttention, sessionBelongsToProject } from "./mobile-selectors.ts";

interface ProjectsScreenProps {
  sessions: MobileSessionInfo[];
  onSelectProject: (project: ProjectSummary) => void;
}

interface ProjectStats {
  count: number;
  attention: boolean;
}

function statsForProject(
  sessions: MobileSessionInfo[],
  projectPath: string,
): ProjectStats {
  let count = 0;
  let attention = false;
  for (const session of sessions) {
    if (session.role === "minion") continue;
    if (!sessionBelongsToProject(session, projectPath)) continue;
    count += 1;
    if (needsAttention(session)) attention = true;
  }
  return { count, attention };
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

    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => {
    const map = new Map<string, ProjectStats>();
    for (const project of projects) {
      map.set(project.id, statsForProject(sessions, project.path));
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
              disabled={creating || !projectPath.trim()}
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
          const stat = stats.get(project.id) ?? { count: 0, attention: false };
          return (
            <button
              className={`mob-project-card${stat.attention ? " mob-project-card--attention" : ""}`}
              key={project.id}
              type="button"
              onClick={() => onSelectProject(project)}
            >
              <span className="mob-project-name">{project.name}</span>
              <span className="mob-project-path">{project.path}</span>
              <span className="mob-project-meta">
                {stat.count === 1 ? "1 session" : `${stat.count} sessions`}
                {stat.attention ? " · needs attention" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </main>
  );
}
