import fs from "fs";
import path from "path";
import os from "os";
import { initDb } from "./db.ts";
import type Database from "better-sqlite3";
import { findWorkspaceBySource, getMinionsHome, registerWorkspace } from "./workspace-registry.ts";
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from "../shared/workspace-contracts.ts";
import { normalizeProjectSandboxPolicy } from "./project-defaults.ts";
export { resolveMinionModelForHarness } from "./project-model-settings.ts";
const SIDECAR_DIR = ".minions";
const GLOBAL_DIR = getMinionsHome();
const RECENT_PROJECTS_FILE = path.join(GLOBAL_DIR, "recent-projects.json");
const LEGACY_RECENT_PROJECTS_FILE = path.join(os.homedir(), SIDECAR_DIR, "recent-projects.json");

export interface RecentProject {
  id?: string;           // stable workspace UUID (absent in legacy indexes)
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
  adaptiveMinionModelRouting?: boolean;
  mechanicalMinionModel?: string;
  reasoningMinionModel?: string;
  defaultMinionThinkingConfig?: ThinkingConfig;
  defaultPermissionMode?: string;
  defaultSandboxPolicy?: SandboxPolicy;
  defaultWorktreeIsolation?: boolean;
  /**
   * Keep the canvas tidy: dropped nodes snap to the grid and shift to the
   * nearest free spot, and dashboards stay affixed to their leader. Absent =
   * on; only `false` disables it.
   */
  tidyLayout?: boolean;
  /** Leader proactive compaction mode; see server/compaction-advisor.ts. */
  proactiveCompaction?: "off" | "recommend" | "auto";
  /** System-model layer mode. */
  systemModel?: "off" | "advisory" | "enforced";
  /** Beta: add decision-oriented role contracts to Leader and Minion prompts. */
  roleSystemBeta?: boolean;
  /**
   * User-configurable Context Actions (Leader slash commands). Ordered and
   * freely extensible. Absent = built-in defaults. Legacy installs stored two
   * parallel records (dashboardLeaderActionNames/Prompts); those are migrated
   * to this array on read — see migrateDashboardActions().
   */
  dashboardLeaderActions?: DashboardLeaderActionConfig[];
  [key: string]: unknown;
}

/** Mirror of src/api.ts DashboardLeaderActionConfig (no cross-tree imports). */
export interface DashboardLeaderActionConfig {
  id: string;
  name: string;
  prompt: string;
  icon: string;
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

function ensureGlobalDir(): void {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  if (RECENT_PROJECTS_FILE !== LEGACY_RECENT_PROJECTS_FILE
    && !fs.existsSync(RECENT_PROJECTS_FILE)
    && fs.existsSync(LEGACY_RECENT_PROJECTS_FILE)
    && fs.lstatSync(LEGACY_RECENT_PROJECTS_FILE).isFile()) {
    fs.copyFileSync(LEGACY_RECENT_PROJECTS_FILE, RECENT_PROJECTS_FILE, fs.constants.COPYFILE_EXCL);
  }
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
  const workspace = findWorkspaceBySource(projectPath) ?? registerWorkspace(projectPath, { nickname: name });
  if (!workspace) throw new Error("Recent projects require a registered workspace");
  const recents = listRecentProjects().filter((r) => r.id !== workspace.id && r.path !== projectPath);
  recents.unshift({
    id: workspace.id,
    path: workspace.sourceRoot,
    name,
    lastOpened: new Date().toISOString(),
  });
  const trimmed = recents.slice(0, 20);
  fs.writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify(trimmed, null, 2));
}

export function removeRecentProject(projectPath: string): void {
  ensureGlobalDir();
  const recents = listRecentProjects().filter((r) => r.path !== projectPath);
  fs.writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify(recents, null, 2));
}

function sidecarPath(projectPath: string): string {
  const workspace = findWorkspaceBySource(projectPath) ?? registerWorkspace(projectPath);
  if (!workspace) throw new Error("Project storage requires a registered workspace");
  return workspace.stateRoot;
}

export function hasSidecar(projectPath: string): boolean {
  return fs.existsSync(path.join(sidecarPath(projectPath), "canvas.db"));
}

/**
 * Initialize central workspace state below MINIONS_HOME.
 * Creates the directory, SQLite DB, empty context.md, and default settings.
 * Returns the initialized database handle.
 */
export function initSidecar(projectPath: string, initialSettings: ProjectSettings): Database.Database {
  const sidecar = sidecarPath(projectPath);
  fs.mkdirSync(sidecar, { recursive: true });

  const dbPath = path.join(sidecar, "canvas.db");
  const db = initDb(dbPath);

  const contextPath = path.join(sidecar, "context.md");
  if (!fs.existsSync(contextPath)) {
    const dirName = path.basename(projectPath);
    fs.writeFileSync(contextPath, `# ${dirName}\n\nProject context has not been configured yet.\n`);
  }

  const settingsPath = path.join(sidecar, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify({
      ...initialSettings,
      dashboardLeaderActions: defaultDashboardLeaderActions(),
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

export function readSettings(projectPath: string): ProjectSettings {
  const settingsPath = path.join(sidecarPath(projectPath), "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return defaultProjectSettings();
  }
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const parsed = migrateDashboardActions(JSON.parse(raw) as ProjectSettings);
    return normalizeProjectSandboxPolicy(
      withLeaderThinkingDefaults({ ...defaultProjectSettings(), ...parsed }, parsed),
    );
  } catch {
    return defaultProjectSettings();
  }
}

/**
 * Prompts that older builds shipped as untouched defaults. When a stored name
 * AND prompt still match one of these, we treat the row as unmodified and swap
 * in the current default copy during migration; any customization wins.
 */
const LEGACY_DEFAULT_ACTIONS: Record<string, { name: string; prompt: string }> = {
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
};

/**
 * Migrate the legacy two-record shape (dashboardLeaderActionNames/Prompts) to
 * the ordered `dashboardLeaderActions` array. A valid stored array wins and is
 * left untouched; otherwise legacy records are merged over the built-ins and
 * the legacy keys are dropped so no compat shape survives the read.
 */
function migrateDashboardActions(settings: ProjectSettings): ProjectSettings {
  const names = asRecord(settings["dashboardLeaderActionNames"]);
  const prompts = asRecord(settings["dashboardLeaderActionPrompts"]);
  const rest = { ...settings };
  delete rest["dashboardLeaderActionNames"];
  delete rest["dashboardLeaderActionPrompts"];

  // A valid array already wins; just make sure no legacy keys survive alongside.
  if (Array.isArray(settings.dashboardLeaderActions)) return rest;

  if (!names && !prompts) {
    return { ...rest, dashboardLeaderActions: defaultDashboardLeaderActions() };
  }

  const dashboardLeaderActions = defaultDashboardLeaderActions().map((base) => {
    let name = typeof names?.[base.id] === "string" ? (names[base.id] as string) : base.name;
    let prompt =
      typeof prompts?.[base.id] === "string" ? (prompts[base.id] as string) : base.prompt;
    // Untouched legacy defaults upgrade to the current default copy.
    const legacy = LEGACY_DEFAULT_ACTIONS[base.id];
    if (legacy && name === legacy.name && prompt === legacy.prompt) {
      name = base.name;
      prompt = base.prompt;
    }
    return { ...base, name, prompt };
  });

  return { ...rest, dashboardLeaderActions };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function defaultProjectSettings(): ProjectSettings {
  return {
    defaultModel: "claude-sonnet-5",
    defaultLeaderHarness: "codex",
    defaultLeaderModel: "gpt-5.6-sol",
    defaultLeaderThinkingConfig: DEFAULT_LEADER_THINKING_CONFIG,
    defaultMinionHarness: "claude",
    defaultMinionModel: "claude-sonnet-5",
    adaptiveMinionModelRouting: false,
    mechanicalMinionModel: "claude-haiku-4-5",
    reasoningMinionModel: "claude-opus-4-8",
    defaultMinionThinkingConfig: DEFAULT_MINION_THINKING_CONFIG,
    defaultPermissionMode: "auto",
    defaultSandboxPolicy: DEFAULT_SANDBOX_POLICY,
    defaultWorktreeIsolation: false,
    systemModel: "off",
    roleSystemBeta: false,
    dashboardLeaderActions: defaultDashboardLeaderActions(),
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

/**
 * Built-in Context Actions written on sidecar init and used by "Reset to
 * defaults". Kept in sync with src/dashboard-leader-actions.ts (no cross-tree
 * imports allowed between server/ and src/).
 */
function defaultDashboardLeaderActions(): DashboardLeaderActionConfig[] {
  return [
    {
      id: "execute",
      name: "Implement",
      icon: "play",
      prompt:
        "Implement the change described by the connected context. Inspect the relevant code, make a complete production-ready change, run focused tests, and summarize what changed.",
    },
    {
      id: "improve",
      name: "Fix",
      icon: "sparkles",
      prompt:
        "Investigate the problem in the connected context. Trace the root cause, implement the smallest robust fix, add or update regression coverage, and verify the result.",
    },
    {
      id: "analyze",
      name: "Review",
      icon: "microscope",
      prompt:
        "Review the connected context and relevant code. Identify concrete bugs, risks, and missing cases, then report prioritized findings with file references. Do not make changes unless asked.",
    },
  ];
}

export function writeSettings(projectPath: string, settings: ProjectSettings): void {
  const settingsPath = path.join(sidecarPath(projectPath), "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(normalizeProjectSandboxPolicy(settings), null, 2));
}

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
