import fs from "fs";
import path from "path";
import os from "os";
import { initDb } from "./db.ts";
import type Database from "better-sqlite3";

const SIDECAR_DIR = ".minions";
const GLOBAL_DIR = path.join(os.homedir(), ".minions");
const RECENT_PROJECTS_FILE = path.join(GLOBAL_DIR, "recent-projects.json");

// ── One-time directory migration ───────────────────────────────────────────

/**
 * One-time migration: rename `~/.claude-canvas` → `~/.minions` on boot.
 *
 * - Old exists, new does not → rename.
 * - Old exists, new also exists → log a warning and leave both; the caller
 *   uses GLOBAL_DIR (.minions) going forward.
 * - Old does not exist → no-op.
 *
 * Exported for direct boot calls and tests.
 */
export function migrateGlobalDir(): void {
  const oldDir = path.join(os.homedir(), ".claude-canvas");
  if (!fs.existsSync(oldDir)) return;
  if (fs.existsSync(GLOBAL_DIR)) {
    console.warn(
      "[migrate] Both ~/.claude-canvas and ~/.minions exist — " +
        "using ~/.minions. You may safely remove ~/.claude-canvas.",
    );
    return;
  }
  fs.renameSync(oldDir, GLOBAL_DIR);
  console.log("[migrate] Renamed ~/.claude-canvas → ~/.minions");
}

/**
 * One-time migration: rename `<projectPath>/.claude-canvas` → `.minions`.
 *
 * Same three-case semantics as `migrateGlobalDir`.
 *
 * Exported for direct boot calls and tests.
 */
export function migrateSidecar(projectPath: string): void {
  const oldSidecar = path.join(projectPath, ".claude-canvas");
  const newSidecar = path.join(projectPath, ".minions");
  if (!fs.existsSync(oldSidecar)) return;
  if (fs.existsSync(newSidecar)) {
    console.warn(
      `[migrate] Both .claude-canvas and .minions exist in ${projectPath} — ` +
        "using .minions.",
    );
    return;
  }
  fs.renameSync(oldSidecar, newSidecar);
  console.log(`[migrate] Renamed .claude-canvas → .minions in ${projectPath}`);
}

export interface RecentProject {
  path: string;          // absolute path to the project working directory
  name: string;          // display name
  lastOpened: string;    // ISO date
}

export interface ProjectContext {
  content: string;       // raw markdown
  exists: boolean;       // whether context.md existed on disk
}

export interface ProjectSettings {
  defaultModel?: string;
  defaultPermissionMode?: string;
  defaultWorktreeIsolation?: boolean;
  [key: string]: unknown;
}

// ── Recent projects index ──────────────────────────────

function ensureGlobalDir(): void {
  migrateGlobalDir();
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
}

export function listRecentProjects(): RecentProject[] {
  ensureGlobalDir();
  if (!fs.existsSync(RECENT_PROJECTS_FILE)) return [];
  try {
    const raw = fs.readFileSync(RECENT_PROJECTS_FILE, "utf-8");
    return JSON.parse(raw) as RecentProject[];
  } catch {
    return [];
  }
}

export function addRecentProject(projectPath: string, name: string): void {
  ensureGlobalDir();
  const recents = listRecentProjects().filter((r) => r.path !== projectPath);
  recents.unshift({
    path: projectPath,
    name,
    lastOpened: new Date().toISOString(),
  });
  // Keep last 20
  const trimmed = recents.slice(0, 20);
  fs.writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify(trimmed, null, 2));
}

export function removeRecentProject(projectPath: string): void {
  ensureGlobalDir();
  const recents = listRecentProjects().filter((r) => r.path !== projectPath);
  fs.writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify(recents, null, 2));
}

// ── Sidecar management ─────────────────────────────────

function sidecarPath(projectPath: string): string {
  return path.join(projectPath, SIDECAR_DIR);
}

export function hasSidecar(projectPath: string): boolean {
  return fs.existsSync(sidecarPath(projectPath));
}

/**
 * Initialize a `.minions` sidecar in the given project directory.
 * Creates the directory, SQLite DB, empty context.md, and default settings.
 * Returns the initialized database handle.
 */
export function initSidecar(projectPath: string): Database.Database {
  const sidecar = sidecarPath(projectPath);
  fs.mkdirSync(sidecar, { recursive: true });

  // Initialize SQLite
  const dbPath = path.join(sidecar, "canvas.db");
  const db = initDb(dbPath);

  // Create context.md if it doesn't exist
  const contextPath = path.join(sidecar, "context.md");
  if (!fs.existsSync(contextPath)) {
    const dirName = path.basename(projectPath);
    fs.writeFileSync(contextPath, `# ${dirName}\n\nProject context has not been configured yet.\n`);
  }

  // Create settings.json if it doesn't exist
  const settingsPath = path.join(sidecar, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify({
      defaultModel: "sonnet",
      defaultPermissionMode: "auto",
      defaultWorktreeIsolation: false,
    }, null, 2));
  }

  return db;
}

/**
 * Open an existing sidecar's database. Runs the one-time `.claude-canvas` →
 * `.minions` migration before checking for the sidecar so existing projects
 * upgrade transparently on first open. Initializes a fresh sidecar if
 * neither the migrated nor a pre-existing one is found.
 */
export function openProjectDb(projectPath: string): Database.Database {
  migrateSidecar(projectPath);
  if (!hasSidecar(projectPath)) {
    return initSidecar(projectPath);
  }
  const dbPath = path.join(sidecarPath(projectPath), "canvas.db");
  return initDb(dbPath);
}

// ── Context.md operations ──────────────────────────────

export function readContext(projectPath: string): ProjectContext {
  const contextPath = path.join(sidecarPath(projectPath), "context.md");
  if (!fs.existsSync(contextPath)) {
    return { content: "", exists: false };
  }
  return {
    content: fs.readFileSync(contextPath, "utf-8"),
    exists: true,
  };
}

export function writeContext(projectPath: string, content: string): void {
  const contextPath = path.join(sidecarPath(projectPath), "context.md");
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, content);
}

// ── Settings operations ────────────────────────────────

export function readSettings(projectPath: string): ProjectSettings {
  const settingsPath = path.join(sidecarPath(projectPath), "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return { defaultModel: "sonnet", defaultPermissionMode: "auto", defaultWorktreeIsolation: false };
  }
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(raw) as ProjectSettings;
  } catch {
    return { defaultModel: "sonnet", defaultPermissionMode: "auto", defaultWorktreeIsolation: false };
  }
}

export function writeSettings(projectPath: string, settings: ProjectSettings): void {
  const settingsPath = path.join(sidecarPath(projectPath), "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ── Skills operations ─────────────────────────────────

export function readSkills(projectPath: string): unknown[] {
  const skillsPath = path.join(sidecarPath(projectPath), "skills.json");
  if (!fs.existsSync(skillsPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(skillsPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeSkills(projectPath: string, skills: unknown[]): void {
  const skillsPath = path.join(sidecarPath(projectPath), "skills.json");
  fs.mkdirSync(path.dirname(skillsPath), { recursive: true });
  fs.writeFileSync(skillsPath, JSON.stringify(skills, null, 2));
}

// ── MCP server operations ─────────────────────────────

/**
 * Read raw MCP server entries from the sidecar. Returns an empty array
 * when the file is missing or malformed — callers do their own schema
 * validation via mcp-server-store.
 */
export function readMcpServers(projectPath: string): unknown[] {
  const filePath = path.join(sidecarPath(projectPath), "mcp-servers.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeMcpServers(
  projectPath: string,
  servers: unknown[],
): void {
  const filePath = path.join(sidecarPath(projectPath), "mcp-servers.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(servers, null, 2));
}
