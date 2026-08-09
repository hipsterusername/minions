import { randomBytes } from "node:crypto";
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
  if (!isSafeSegment(segment)) {
    throw new Error(`unsafe artifact segment: ${segment}`);
  }
}

function assertUnderRoot(targetPath: string): string {
  const root = path.resolve(htmlArtifactsRoot());
  const resolved = path.resolve(targetPath);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  if (!resolved.startsWith(rootWithSeparator)) {
    throw new Error(`artifact path escapes root: ${resolved}`);
  }

  return resolved;
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

  const sessionDir = assertUnderRoot(path.join(htmlArtifactsRoot(), sessionKey));
  const artifactPath = assertUnderRoot(path.join(sessionDir, `${id}.html`));
  const bytes = Buffer.byteLength(args.html, "utf8");

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(artifactPath, args.html, "utf8");

  return {
    id,
    sessionKey,
    title: args.title,
    createdAt: Date.now(),
    path: artifactPath,
    bytes,
  };
}

export async function deleteHtmlArtifactsForSession(sessionKey: string): Promise<void> {
  validateSegment(sessionKey);

  const sessionDir = assertUnderRoot(path.join(htmlArtifactsRoot(), sessionKey));
  await fs.rm(sessionDir, { recursive: true, force: true });
}

export async function sweepOrphanHtmlArtifacts(knownSessionKeys: Iterable<string>): Promise<number> {
  const known = new Set(knownSessionKeys);
  const root = path.resolve(htmlArtifactsRoot());
  let entries;

  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || known.has(entry.name)) {
      continue;
    }

    const sessionDir = assertUnderRoot(path.join(root, entry.name));
    await fs.rm(sessionDir, { recursive: true, force: true });
    removed += 1;
  }

  return removed;
}
