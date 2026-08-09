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

function ensureWorkspacesRoot(): string {
  const root = workspacesRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Minions workspaces root must be a real directory");
  }
  return root;
}

function binding(stored: StoredWorkspace): WorkspaceBinding {
  return { ...stored, stateRoot: path.join(workspacesRoot(), stored.id) };
}

function safeBinding(stored: StoredWorkspace, create: boolean): WorkspaceBinding | null {
  const result = binding(stored);
  try {
    if (create) {
      ensureWorkspacesRoot();
      fs.mkdirSync(result.stateRoot, { recursive: true, mode: 0o700 });
    }
    const rootStat = fs.lstatSync(workspacesRoot());
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
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
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)
      || !parsed.workspaces.every(isStoredWorkspace)) {
      throw new Error("invalid registry schema");
    }
    return parsed.workspaces;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Workspace registry is unreadable or malformed: ${registryPath()}`, { cause: error });
  }
}

function writeRegistry(workspaces: StoredWorkspace[]): void {
  ensureWorkspacesRoot();
  const target = registryPath();
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, workspaces }, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

interface RegistryLockOwner { token: string; pid: number; createdAt: number }

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function recoverStaleRegistryLock(lockPath: string): boolean {
  const stat = fs.lstatSync(lockPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Workspace registry lock must be a real directory");
  }
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as
      Partial<RegistryLockOwner>;
    if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      if (processIsAlive(owner.pid)) return false;
      fs.rmSync(lockPath, { recursive: true });
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && error instanceof SyntaxError === false) {
      throw error;
    }
  }
  // A creator can briefly exist before owner.json is installed. Only recover
  // ownerless/corrupt locks once they are old enough that this cannot be that
  // acquisition window.
  if (Date.now() - stat.mtimeMs < 30_000) return false;
  fs.rmSync(lockPath, { recursive: true });
  return true;
}

function withRegistrationLock<T>(operation: () => T): T {
  const root = ensureWorkspacesRoot();
  const lockPath = path.join(root, ".registry.lock");
  const owner: RegistryLockOwner = { token: crypto.randomUUID(), pid: process.pid, createdAt: Date.now() };
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 500) {
        throw new Error("Unable to acquire workspace registry lock", { cause: error });
      }
      if (recoverStaleRegistryLock(lockPath)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    try {
      const current = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as
        Partial<RegistryLockOwner>;
      if (current.token === owner.token) fs.rmSync(lockPath, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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
  return withRegistrationLock(() => {
    const records = readRegistry();
    const existing = records.find((row) => row.sourceRoot === sourceRoot);
    if (existing) return safeBinding(existing, true);

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
  });
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
