import fs from "fs";
import path from "path";
import os from "os";
import { initDb } from "./db.ts";
import type Database from "better-sqlite3";
export { resolveMinionModelForHarness } from "./project-model-settings.ts";

const SIDECAR_DIR = ".minions";
const GLOBAL_DIR = path.join(os.homedir(), ".minions");
const RECENT_PROJECTS_FILE = path.join(GLOBAL_DIR, "recent-projects.json");

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
  defaultLeaderHarness?: string;
  defaultLeaderModel?: string;
  defaultLeaderThinkingConfig?: ThinkingConfig;
  defaultMinionHarness?: string;
  defaultMinionModel?: string;
  mechanicalMinionModel?: string;
  reasoningMinionModel?: string;
  defaultMinionThinkingConfig?: ThinkingConfig;
  defaultPermissionMode?: string;
  defaultWorktreeIsolation?: boolean;
  /**
   * Keep the canvas tidy: dropped nodes snap to the grid and shift to the
   * nearest free spot, and dashboards stay affixed to their leader. Absent =
   * on; only `false` disables it.
   */
  tidyLayout?: boolean;
  /** Leader proactive compaction mode; see server/compaction-advisor.ts. */
  proactiveCompaction?: "off" | "recommend" | "auto";
  /** System-model layer mode; see docs/system-model-implementation-plan.md. */
  systemModel?: "off" | "advisory" | "enforced";
  dashboardLeaderActionPrompts?: {
    improve?: string;
    execute?: string;
    analyze?: string;
  };
  dashboardLeaderActionNames?: {
    improve?: string;
    execute?: string;
    analyze?: string;
  };
  [key: string]: unknown;
}

export type ExecutorClass = "mechanical" | "standard" | "reasoning";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingDisplay = "summarized" | "omitted";

export interface ThinkingConfig {
  enabled: boolean;
  effort: EffortLevel;
  display: ThinkingDisplay;
}

const DEFAULT_LEADER_THINKING_CONFIG: ThinkingConfig = {
  enabled: true,
  effort: "high",
  display: "summarized",
};

const DEFAULT_MINION_THINKING_CONFIG: ThinkingConfig = {
  enabled: true,
  effort: "medium",
  display: "summarized",
};

// ── Recent projects index ──────────────────────────────

function ensureGlobalDir(): void {
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
export function initSidecar(projectPath: string, initialSettings: ProjectSettings): Database.Database {
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
      ...initialSettings,
      dashboardLeaderActionNames: defaultDashboardLeaderActionNames(),
      dashboardLeaderActionPrompts: defaultDashboardLeaderActionPrompts(),
    }, null, 2));
  }

  return db;
}

export function openProjectDb(projectPath: string): Database.Database {
  if (!hasSidecar(projectPath)) {
    return initSidecar(projectPath, {});
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
    return defaultProjectSettings();
  }
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const parsed = migrateLegacyDashboardActions(JSON.parse(raw) as ProjectSettings);
    return withLeaderThinkingDefaults({ ...defaultProjectSettings(), ...parsed }, parsed);
  } catch {
    return defaultProjectSettings();
  }
}

const LEGACY_DASHBOARD_ACTIONS = {
  improve: {
    name: "Improve",
    prompt: "Improve the connected dashboard context. Identify the highest-impact changes, then implement or produce the improved result.",
  },
  execute: {
    name: "Execute",
    prompt: "Execute the work implied by the connected dashboard context. Use the dashboard as source context and carry the task through to completion.",
  },
  analyze: {
    name: "Analyze",
    prompt: "Analyze the connected dashboard context. Summarize the key findings, risks, and recommended next steps.",
  },
} as const;

/** Upgrade only untouched defaults; any customized name or prompt wins. */
function migrateLegacyDashboardActions(settings: ProjectSettings): ProjectSettings {
  const names = { ...settings.dashboardLeaderActionNames };
  const prompts = { ...settings.dashboardLeaderActionPrompts };
  const nextNames = defaultDashboardLeaderActionNames();
  const nextPrompts = defaultDashboardLeaderActionPrompts();
  let changed = false;

  for (const action of Object.keys(LEGACY_DASHBOARD_ACTIONS) as Array<keyof typeof LEGACY_DASHBOARD_ACTIONS>) {
    const legacy = LEGACY_DASHBOARD_ACTIONS[action];
    if (names[action] === legacy.name && prompts[action] === legacy.prompt) {
      names[action] = nextNames[action];
      prompts[action] = nextPrompts[action];
      changed = true;
    }
  }

  return changed
    ? { ...settings, dashboardLeaderActionNames: names, dashboardLeaderActionPrompts: prompts }
    : settings;
}

function defaultProjectSettings(): ProjectSettings {
  return {
    defaultModel: "claude-sonnet-5",
    defaultLeaderHarness: "codex",
    defaultLeaderModel: "gpt-5.6-sol",
    defaultLeaderThinkingConfig: DEFAULT_LEADER_THINKING_CONFIG,
    defaultMinionHarness: "claude",
    defaultMinionModel: "claude-sonnet-5",
    mechanicalMinionModel: "claude-haiku-4-5",
    reasoningMinionModel: "claude-opus-4-8",
    defaultMinionThinkingConfig: DEFAULT_MINION_THINKING_CONFIG,
    defaultPermissionMode: "auto",
    defaultWorktreeIsolation: false,
    systemModel: "off",
    dashboardLeaderActionNames: defaultDashboardLeaderActionNames(),
    dashboardLeaderActionPrompts: defaultDashboardLeaderActionPrompts(),
  };
}

function withLeaderThinkingDefaults(
  settings: ProjectSettings,
  stored: ProjectSettings,
): ProjectSettings {
  if (Object.prototype.hasOwnProperty.call(stored, "defaultLeaderThinkingConfig")) {
    return settings;
  }
  if (!isFableModel(settings.defaultLeaderModel)) return settings;
  return {
    ...settings,
    defaultLeaderThinkingConfig: {
      ...DEFAULT_LEADER_THINKING_CONFIG,
      effort: "medium",
    },
  };
}

function isFableModel(model: unknown): boolean {
  return model === "claude-fable-5" || model === "fable";
}

function defaultDashboardLeaderActionNames(): NonNullable<
  ProjectSettings["dashboardLeaderActionNames"]
> {
  return {
    improve: "Fix",
    execute: "Implement",
    analyze: "Review",
  };
}

function defaultDashboardLeaderActionPrompts(): NonNullable<
  ProjectSettings["dashboardLeaderActionPrompts"]
> {
  return {
    improve:
      "Investigate the problem in the connected context. Trace the root cause, implement the smallest robust fix, add or update regression coverage, and verify the result.",
    execute:
      "Implement the change described by the connected context. Inspect the relevant code, make a complete production-ready change, run focused tests, and summarize what changed.",
    analyze:
      "Review the connected context and relevant code. Identify concrete bugs, risks, and missing cases, then report prioritized findings with file references. Do not make changes unless asked.",
  };
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
