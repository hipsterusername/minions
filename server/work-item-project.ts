import { validateProjectPath } from "./path-guard.ts";
import { openProjectDb } from "./project-store.ts";
import { legacyProjectIdentity } from "./work-item-migration.ts";
import { encodePath } from "./routes/projects/helpers.ts";
import { resolveWorkspace } from "./workspace-registry.ts";

export interface WorkItemProjectIdentity {
  projectId: string;
  projectPath: string;
  aliases: string[];
}

/** Resolve every identifier historically used for a registered project. */
export function resolveWorkItemProjectIdentity(projectId: string): WorkItemProjectIdentity | null {
  const workspace = resolveWorkspace(projectId);
  if (!workspace) return null;
  const aliases = new Set<string>([
    encodePath(workspace.sourceRoot),
    legacyProjectIdentity(null, workspace.sourceRoot, null).projectId,
  ]);
  const db = openProjectDb(workspace.sourceRoot);
  try {
    const rows = db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
    for (const row of rows) aliases.add(row.id);
  } finally {
    db.close();
  }
  aliases.delete(workspace.id);
  return { projectId: workspace.id, projectPath: workspace.sourceRoot, aliases: [...aliases] };
}

/** Validate both registered path ownership and the canvas project stored there. */
export function resolveWorkItemProject(projectId: string, projectPath: string): string | null {
  const canonicalPath = validateProjectPath(projectPath);
  if (!canonicalPath) return null;
  // Public project IDs are stable workspace UUIDs for newly registered
  // sources. Fence the lookup to the supplied canonical source so a valid UUID
  // cannot be paired with a different registered project path.
  if (resolveWorkspace(projectId, canonicalPath)) return canonicalPath;
  const db = openProjectDb(canonicalPath);
  try {
    const row = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    // Legacy sessions were backfilled before every per-project canvas row had
    // been copied into the global runtime. Their durable project identity is a
    // path-derived alias. It still proves ownership of this exact registered
    // path and must remain accepted while those leaders are rebound.
    const legacyId = legacyProjectIdentity(null, canonicalPath, null).projectId;
    // REST project payloads intentionally expose the base64url path identity,
    // not the private UUID stored in the sidecar's projects row.
    const publicId = encodePath(canonicalPath);
    return row || projectId === publicId || projectId === legacyId ? canonicalPath : null;
  } finally {
    db.close();
  }
}
