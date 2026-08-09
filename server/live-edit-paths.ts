import fs from "node:fs";
import path from "node:path";

export type LiveEditPathScope = "file" | "prefix";
export interface LiveEditPathInput { path: string; scope: LiveEditPathScope }
export interface CanonicalLiveEditPath { path: string; absolutePath: string; scope: LiveEditPathScope }

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveThroughExistingAncestor(absolute: string): string {
  let cursor = absolute;
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const real = fs.realpathSync(cursor);
  return path.join(real, ...suffix);
}

/** Resolve path identity through symlinks while rejecting traversal and project escape. */
export function canonicalizeLiveEditPaths(
  projectPath: string,
  inputs: readonly LiveEditPathInput[],
): CanonicalLiveEditPath[] {
  const root = fs.realpathSync(projectPath);
  const result = new Map<string, CanonicalLiveEditPath>();
  for (const input of inputs) {
    if (!input.path || path.isAbsolute(input.path)) throw new Error("live-edit paths must be project-relative");
    const lexical = path.resolve(root, input.path);
    if (!within(root, lexical)) throw new Error(`live-edit path escapes project: ${input.path}`);
    const resolved = resolveThroughExistingAncestor(lexical);
    if (!within(root, resolved)) throw new Error(`live-edit symlink escapes project: ${input.path}`);
    const relative = path.relative(root, resolved).split(path.sep).join("/") || ".";
    const key = `${input.scope}:${relative}`;
    result.set(key, { path: relative, absolutePath: resolved, scope: input.scope });
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope));
}

export function liveEditPathsOverlap(a: CanonicalLiveEditPath, b: CanonicalLiveEditPath): boolean {
  if (a.path === "." || b.path === ".") return true;
  if (a.path === b.path) return true;
  const aContainsB = b.path.startsWith(`${a.path}/`);
  const bContainsA = a.path.startsWith(`${b.path}/`);
  return (a.scope === "prefix" && aContainsB) || (b.scope === "prefix" && bContainsA);
}
