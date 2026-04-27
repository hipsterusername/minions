import type { CanvasNode, CanvasTransform } from "./types.ts";

const BASE = "/api";

// ── Auth token ──────────────────────────────────────────
// Fetched once from the server at startup, then cached.
let _authToken: string | null = null;
let _tokenPromise: Promise<string> | null = null;

export function clearAuthToken(): void {
  _authToken = null;
  _tokenPromise = null;
}

export function getAuthToken(): Promise<string> {
  if (_authToken) return Promise.resolve(_authToken);
  if (!_tokenPromise) {
    _tokenPromise = fetch(`${BASE}/auth/token`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch auth token: ${res.status}`);
        return res.json() as Promise<{ token: string }>;
      })
      .then(({ token }) => {
        _authToken = token;
        return token;
      });
  }
  return _tokenPromise;
}

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
  defaultWorktreeIsolation?: boolean;
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
  skills?: import("./skills/types.ts").SkillTemplate[];
}

// ── Fetch helper ─────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...((options?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
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

// ── Skills (per-project) ─────────────────────────────────

export function getProjectSkills(id: string): Promise<import("./skills/types.ts").SkillTemplate[]> {
  return apiFetch(`/projects/${id}/skills`);
}

export function saveProjectSkills(
  id: string,
  skills: import("./skills/types.ts").SkillTemplate[],
): Promise<unknown> {
  return apiFetch(`/projects/${id}/skills`, {
    method: "PUT",
    body: JSON.stringify(skills),
  });
}

// ── MCP servers (per-project) ────────────────────────────

import type { McpServerEntry } from "../shared/mcp-servers/types.ts";

export interface ListMcpServersResult {
  entries: McpServerEntry[];
  invalid: { index: number; errors: { path: string; message: string }[] }[];
}

export function listProjectMcpServers(id: string): Promise<ListMcpServersResult> {
  return apiFetch(`/projects/${id}/mcp-servers`);
}

export function saveProjectMcpServer(
  id: string,
  entry: McpServerEntry,
): Promise<McpServerEntry> {
  return apiFetch(`/projects/${id}/mcp-servers/${entry.id}`, {
    method: "PUT",
    body: JSON.stringify(entry),
  });
}

export function deleteProjectMcpServer(
  id: string,
  serverId: string,
): Promise<{ ok: true }> {
  return apiFetch(`/projects/${id}/mcp-servers/${serverId}`, {
    method: "DELETE",
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

// ── Routines (per-project) ───────────────────────────────

import type { Routine } from "../shared/routines/types.ts";

export interface RoutineListResult {
  routines: Routine[];
  invalid: { file: string; errors: { path: string; message: string }[] }[];
}

export function listProjectRoutines(id: string): Promise<RoutineListResult> {
  return apiFetch(`/projects/${id}/routines`);
}

export function getProjectRoutine(id: string, routineId: string): Promise<Routine> {
  return apiFetch(`/projects/${id}/routines/${routineId}`);
}

export function saveProjectRoutine(id: string, routine: Routine): Promise<Routine> {
  return apiFetch(`/projects/${id}/routines/${routine.id}`, {
    method: "PUT",
    body: JSON.stringify(routine),
  });
}

export function deleteProjectRoutine(
  id: string,
  routineId: string,
): Promise<{ ok: true }> {
  return apiFetch(`/projects/${id}/routines/${routineId}`, {
    method: "DELETE",
  });
}

// Re-export encodePath for consumers that need to convert raw paths to IDs
export { encodePath };
