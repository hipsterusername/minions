import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./worktree-exec.ts";
import type { DetailedDiff, FileChange } from "./worktree-types.ts";

/** Read the shared workspace without staging files or attributing them to one agent. */
export async function getWorkspaceDiff(cwd: string): Promise<DetailedDiff> {
  const root = (await exec(["rev-parse", "--show-toplevel"], cwd)).stdout.trim();
  const branch = (await exec(["rev-parse", "--abbrev-ref", "HEAD"], root)
    .catch(() => ({ stdout: "Unborn branch" }))).stdout.trim();
  const hasHead = await exec(["rev-parse", "--verify", "HEAD"], root).then(() => true, () => false);
  const files = new Map<string, FileChange>();
  if (hasHead) {
    const [stats, statuses] = await Promise.all([
      exec(["diff", "--numstat", "--no-renames", "-z", "HEAD", "--"], root),
      exec(["diff", "--name-status", "--no-renames", "-z", "HEAD", "--"], root),
    ]);
    for (const entry of stats.stdout.split("\0").filter(Boolean)) {
      const match = /^([^\t]+)\t([^\t]+)\t([\s\S]+)$/.exec(entry);
      if (!match) continue;
      const [, additions, deletions, file] = match;
      files.set(file!, { file: file!, insertions: Number(additions) || 0,
        deletions: Number(deletions) || 0, status: "modified" });
    }
    const entries = statuses.stdout.split("\0");
    for (let i = 0; i + 1 < entries.length; i += 2) {
      const file = files.get(entries[i + 1]!);
      if (file) file.status = entries[i] === "A" ? "added" : entries[i] === "D" ? "deleted" : "modified";
    }
  }
  const untracked = await exec(["ls-files", ...(hasHead ? [] : ["--cached"]),
    "--others", "--exclude-standard", "-z"], root);
  for (const file of untracked.stdout.split("\0").filter(Boolean)) {
    if (files.has(file)) continue;
    const absolute = path.join(root, file);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) continue;
    const bytes = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(absolute)) : await fs.readFile(absolute);
    const text = bytes.toString("utf8");
    const insertions = bytes.includes(0) || !text ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    files.set(file, { file, insertions, deletions: 0, status: "added" });
  }
  const changes = [...files.values()];
  return { filesChanged: changes.length, files: changes, commits: [], branch,
    insertions: changes.reduce((n, file) => n + file.insertions, 0),
    deletions: changes.reduce((n, file) => n + file.deletions, 0) };
}
