import type { CanvasNode, CanvasTransform } from "./types.ts";

const BASE = "/api";

// ── Encoding helper ─────────────────────────────────────
// Project paths are base64url-encoded for use in URL segments
function encodePath(p: string): string {
  // TextEncoder → btoa → make URL-safe
  const bytes = new TextEncoder().encode(p);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Types ────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;           // base64url-encoded path
  path: string;         // absolute filesystem path
  name: string;
  lastOpened: string;
  hasSidecar: boolean;
}

export interface ProjectContext {
  content: string;
  exists: boolean;
}

export interface ProjectSettings {
  defaultModel?: string;
  defaultPermissionMode?: string;
  [key: string]: unknown;
}

export interface ProjectWithNodes {
  id: string;
  path: string;
  name: string;
  transform: CanvasTransform;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNode[];
  context?: ProjectContext;
  settings?: ProjectSettings;
}

// ── Fetch helper ─────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Project CRUD ─────────────────────────────────────────

export function listProjects(): Promise<ProjectSummary[]> {
  return apiFetch("/projects");
}

export function createProject(name: string, projectPath: string): Promise<ProjectWithNodes> {
  return apiFetch("/projects", {
    method: "POST",
    body: JSON.stringify({ name, path: projectPath }),
  });
}

export function openProject(projectPath: string): Promise<ProjectWithNodes> {
  return apiFetch("/projects/open", {
    method: "POST",
    body: JSON.stringify({ path: projectPath }),
  });
}

export function getProject(id: string): Promise<ProjectWithNodes> {
  return apiFetch(`/projects/${id}`);
}

export function updateProject(
  id: string,
  data: { name?: string; transform?: CanvasTransform },
): Promise<unknown> {
  return apiFetch(`/projects/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteProject(id: string): Promise<unknown> {
  return apiFetch(`/projects/${id}`, { method: "DELETE" });
}

export function saveProjectState(
  id: string,
  state: { transform: CanvasTransform; nodes: CanvasNode[] },
): Promise<unknown> {
  return apiFetch(`/projects/${id}/state`, {
    method: "PUT",
    body: JSON.stringify(state),
  });
}

// ── Context.md ───────────────────────────────────────────

export function getProjectContext(id: string): Promise<ProjectContext> {
  return apiFetch(`/projects/${id}/context`);
}

export function updateProjectContext(id: string, content: string): Promise<unknown> {
  return apiFetch(`/projects/${id}/context`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

// ── Settings ─────────────────────────────────────────────

export function getProjectSettings(id: string): Promise<ProjectSettings> {
  return apiFetch(`/projects/${id}/settings`);
}

export function updateProjectSettings(id: string, settings: ProjectSettings): Promise<unknown> {
  return apiFetch(`/projects/${id}/settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// ── Directory tree ──────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string;       // relative to project root
  type: "dir" | "file";
  children?: TreeNode[];
}

export interface ProjectTree {
  root: string;
  tree: TreeNode[];
}

export function getProjectTree(id: string, depth = 2): Promise<ProjectTree> {
  return apiFetch(`/projects/${id}/tree?depth=${depth}`);
}

// Re-export encodePath for consumers that need to convert raw paths to IDs
export { encodePath };
