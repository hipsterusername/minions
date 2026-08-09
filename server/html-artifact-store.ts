import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getMinionsHome } from "./workspace-registry.ts";

export interface HtmlArtifactMeta {
  id: string;
  sessionKey: string;
  title?: string;
  createdAt: number;
  path: string;
  bytes: number;
}

function isSafeSegment(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..";
}

function validateSegment(segment: string): void {
  if (!isSafeSegment(segment)) throw new Error(`unsafe artifact segment: ${segment}`);
}

function sessionToken(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

function artifactFilename(sessionKey: string, id: string): string {
  return `${sessionToken(sessionKey)}--${id}.html`;
}

function artifactSessionFromFilename(filename: string): string | null {
  const separator = filename.indexOf("--");
  if (separator <= 0 || !filename.endsWith(".html")) return null;
  try {
    return Buffer.from(filename.slice(0, separator), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Create the configured root, then return its canonical target. All later
 * operations use that target directly, so benign symlink ancestors (including
 * macOS /var -> /private/var) are supported without following a mutable
 * session-directory component.
 */
async function canonicalArtifactRoot(create: boolean): Promise<string | null> {
  const configured = path.resolve(htmlArtifactsRoot());
  if (create) await fs.mkdir(configured, { recursive: true, mode: 0o700 });
  try {
    const canonical = await fs.realpath(configured);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error(`artifact root is not a directory: ${configured}`);
    return canonical;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function htmlArtifactsRoot(): string {
  return process.env.MINIONS_ARTIFACTS_DIR ?? path.join(getMinionsHome(), "artifacts", "html");
}

export async function writeHtmlArtifact(
  sessionKey: string,
  args: { id?: string; html: string; title?: string },
): Promise<HtmlArtifactMeta> {
  validateSegment(sessionKey);
  const id = args.id ?? randomBytes(8).toString("hex");
  validateSegment(id);

  const root = (await canonicalArtifactRoot(true))!;
  const artifactPath = path.join(root, artifactFilename(sessionKey, id));
  const bytes = Buffer.byteLength(args.html, "utf8");

  // Artifact IDs are immutable. O_EXCL avoids truncating an attacker-selected
  // existing file, and O_NOFOLLOW rejects a final-component symlink.
  const handle = await fs.open(artifactPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(args.html, "utf8");
  } catch (error) {
    await handle.close();
    await fs.unlink(artifactPath).catch(() => undefined);
    throw error;
  }
  await handle.close();

  return { id, sessionKey, title: args.title, createdAt: Date.now(), path: artifactPath, bytes };
}

export async function deleteHtmlArtifactsForSession(sessionKey: string): Promise<void> {
  validateSegment(sessionKey);
  const root = await canonicalArtifactRoot(false);
  if (!root) return;
  const prefix = `${sessionToken(sessionKey)}--`;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".html")) {
      await fs.unlink(path.join(root, entry.name));
    }
  }

  // Remove the legacy per-session directory only when it is a real directory.
  const legacyDir = path.join(root, sessionKey);
  try {
    const stat = await fs.lstat(legacyDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`artifact session is not a real contained directory: ${legacyDir}`);
    }
    await fs.rm(legacyDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function sweepOrphanHtmlArtifacts(knownSessionKeys: Iterable<string>): Promise<number> {
  const known = new Set(knownSessionKeys);
  const root = await canonicalArtifactRoot(false);
  if (!root) return 0;
  const entries = await fs.readdir(root, { withFileTypes: true });
  const removedSessions = new Set<string>();

  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isFile()) {
      const sessionKey = artifactSessionFromFilename(entry.name);
      if (sessionKey !== null && !known.has(sessionKey)) {
        await fs.unlink(target);
        removedSessions.add(sessionKey);
      }
      continue;
    }
    // Backward-compatible cleanup for the old per-session layout. Never
    // traverse directory symlinks.
    if (entry.isDirectory() && !entry.isSymbolicLink() && !known.has(entry.name)) {
      await fs.rm(target, { recursive: true });
      removedSessions.add(entry.name);
    }
  }
  return removedSessions.size;
}
