import { validateProjectPath } from "./path-guard.ts";
import { openProjectDb } from "./project-store.ts";
import { legacyProjectIdentity } from "./work-item-migration.ts";
import { encodePath } from "./routes/projects/helpers.ts";

/** Validate both registered path ownership and the canvas project stored there. */
export function resolveWorkItemProject(projectId: string, projectPath: string): string | null {
  const canonicalPath = validateProjectPath(projectPath);
  if (!canonicalPath) return null;
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
