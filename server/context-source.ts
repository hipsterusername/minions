/** Immutable full text behind bounded prompt excerpts; paths are ordinary readable files. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findWorkspaceBySource } from "./workspace-registry.ts";

export function persistContextSource(projectPath: string, content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  const workspace = findWorkspaceBySource(projectPath);
  if (!workspace) return undefined;
  const hash = createHash("sha256").update(content).digest("hex");
  const root = path.join(workspace.stateRoot, "context-sources");
  fs.mkdirSync(root, { recursive: true });
  // Refuse an escaped directory even if local state was tampered with.
  const relative = path.relative(fs.realpathSync(workspace.stateRoot), fs.realpathSync(root));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Context source path escapes workspace state");
  const filename = path.join(root, `${hash}.txt`);
  try { fs.writeFileSync(filename, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (fs.lstatSync(filename).isSymbolicLink() || fs.readFileSync(filename, "utf8") !== content) {
    throw new Error("Context source integrity mismatch");
  }
  return filename;
}
