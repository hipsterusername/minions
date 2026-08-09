import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WorkspaceBinding {
  id: string;
  sourceRoot: string;
  stateRoot: string;
  createdAt: string;
}

interface StoredWorkspace {
  id: string;
  sourceRoot: string;
  createdAt: string;
}

interface RegistryFile {
  version: 1;
  workspaces: StoredWorkspace[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getMinionsHome(): string {
  return path.resolve(process.env["MINIONS_HOME"] ?? path.join(os.homedir(), ".minions"));
}

function workspacesRoot(): string {
  return path.join(getMinionsHome(), "workspaces");
}

function registryPath(): string {
  return path.join(workspacesRoot(), "registry.json");
}

function binding(stored: StoredWorkspace): WorkspaceBinding {
  return { ...stored, stateRoot: path.join(workspacesRoot(), stored.id) };
}

function safeBinding(stored: StoredWorkspace, create: boolean): WorkspaceBinding | null {
  const result = binding(stored);
  try {
    if (create) {
      fs.mkdirSync(workspacesRoot(), { recursive: true, mode: 0o700 });
      fs.mkdirSync(result.stateRoot, { recursive: true, mode: 0o700 });
    }
    const stateStat = fs.lstatSync(result.stateRoot);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) return null;
    const rootReal = fs.realpathSync(workspacesRoot());
    const stateReal = fs.realpathSync(result.stateRoot);
    const relative = path.relative(rootReal, stateReal);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return result;
  } catch {
    return null;
  }
}

function isStoredWorkspace(value: unknown): value is StoredWorkspace {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row["id"] === "string" && UUID.test(row["id"])
    && typeof row["sourceRoot"] === "string" && path.isAbsolute(row["sourceRoot"])
    && typeof row["createdAt"] === "string";
}

function readRegistry(): StoredWorkspace[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as Partial<RegistryFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) return [];
    return parsed.workspaces.filter(isStoredWorkspace);
  } catch {
    return [];
  }
}

function writeRegistry(workspaces: StoredWorkspace[]): void {
  const root = workspacesRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = registryPath();
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, workspaces }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** Resolve an absolute source path through existing ancestors and symlinks. */
export function canonicalizeSourceRoot(sourcePath: string): string | null {
  if (!path.isAbsolute(sourcePath)) return null;
  const resolved = path.resolve(sourcePath);
  let ancestor = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  try {
    if (!fs.statSync(ancestor).isDirectory()) return null;
    return path.join(fs.realpathSync(ancestor), ...missing);
  } catch {
    return null;
  }
}

function copyLegacyEntry(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyLegacyEntry(path.join(source, name), path.join(destination, name));
    }
  } else if (stat.isFile() && !fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

function importLegacySidecar(sourceRoot: string, stateRoot: string): void {
  const legacy = path.join(sourceRoot, ".minions");
  if (!fs.existsSync(legacy) || !fs.lstatSync(legacy).isDirectory()) return;
  for (const name of fs.readdirSync(legacy)) {
    copyLegacyEntry(path.join(legacy, name), path.join(stateRoot, name));
  }
}

/** Register a canonical source root and return its stable, durable binding. */
export function registerWorkspace(sourcePath: string): WorkspaceBinding | null {
  const sourceRoot = canonicalizeSourceRoot(sourcePath);
  if (!sourceRoot) return null;
  const records = readRegistry();
  const existing = records.find((row) => row.sourceRoot === sourceRoot);
  if (existing) {
    return safeBinding(existing, true);
  }

  const stored: StoredWorkspace = {
    id: crypto.randomUUID(),
    sourceRoot,
    createdAt: new Date().toISOString(),
  };
  const result = safeBinding(stored, true);
  if (!result) return null;
  importLegacySidecar(sourceRoot, result.stateRoot);
  writeRegistry([...records, stored]);
  return result;
}

export function resolveWorkspace(id: string, expectedSourceRoot?: string): WorkspaceBinding | null {
  if (!UUID.test(id)) return null;
  const stored = readRegistry().find((row) => row.id === id);
  if (!stored) return null;
  if (expectedSourceRoot !== undefined) {
    const expected = canonicalizeSourceRoot(expectedSourceRoot);
    if (!expected || expected !== stored.sourceRoot) return null;
  }
  return safeBinding(stored, false);
}

export function findWorkspaceBySource(sourcePath: string): WorkspaceBinding | null {
  const canonical = canonicalizeSourceRoot(sourcePath);
  if (!canonical) return null;
  const stored = readRegistry().find((row) => row.sourceRoot === canonical);
  return stored ? safeBinding(stored, false) : null;
}

export function listWorkspaces(): WorkspaceBinding[] {
  return readRegistry().map((row) => safeBinding(row, false)).filter((row) => row !== null);
}
