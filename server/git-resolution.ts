import fs from "node:fs/promises";
import { exec } from "./worktree-exec.ts";
import { isOwnedWorktreePath } from "./worktree-owned-root.ts";

export async function prepareGitResolution(input: { repositoryPath: string; worktreePath: string;
  sourceRef: string; targetRef: string; strategy?: "manual" | "ours" | "theirs" }): Promise<void> {
  if (!isOwnedWorktreePath(input.repositoryPath, input.worktreePath)) throw new Error("Resolution requires an owned worktree");
  const cwd = input.worktreePath;
  const branch = (await exec(["symbolic-ref", "--short", "HEAD"], cwd)).stdout.trim();
  if (branch !== input.sourceRef.replace(/^refs\/heads\//, "")) throw new Error("Resolution worktree branch changed");
  const target = (await exec(["rev-parse", "--verify", `${input.targetRef}^{commit}`], input.repositoryPath)).stdout.trim();
  let merging = false;
  try { await exec(["rev-parse", "--verify", "MERGE_HEAD"], cwd); merging = true; } catch { /* no pending merge */ }
  if (!merging) {
    if ((await exec(["status", "--porcelain"], cwd)).stdout.trim()) throw new Error("Collect existing edits before preparing conflict resolution");
    try { await exec(["merge", "--no-commit", "--no-ff", target,
      ...(input.strategy && input.strategy !== "manual" ? ["-X", input.strategy] : [])], cwd); }
    catch (error) {
      if (!(await exec(["ls-files", "--unmerged", "-z"], cwd)).stdout) throw error;
    }
  }
  if (input.strategy && input.strategy !== "manual") {
    const entries = (await exec(["ls-files", "--unmerged", "-z"], cwd)).stdout.split("\0").filter(Boolean);
    const paths = new Map<string, Set<string>>();
    for (const entry of entries) {
      const tab = entry.indexOf("\t"); const file = entry.slice(tab + 1);
      const stages = paths.get(file) ?? new Set<string>(); stages.add(entry.slice(0, tab).split(" ")[2]!); paths.set(file, stages);
    }
    for (const [file, stages] of paths) {
      if (stages.has(input.strategy === "ours" ? "2" : "3")) {
        await exec(["checkout", `--${input.strategy}`, "--", file], cwd);
        await exec(["add", "--", file], cwd);
      } else await exec(["rm", "--", file], cwd);
    }
  }
}

/** Agents edit files only; the server checks resolutions before staging the index. */
export async function assertResolvedFiles(cwd: string): Promise<void> {
  const entries = (await exec(["diff", "--name-only", "--diff-filter=U", "-z"], cwd)).stdout.split("\0").filter(Boolean);
  for (const file of entries) {
    let bytes: Buffer;
    try { bytes = await fs.readFile(`${cwd}/${file}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (bytes.includes(0) || /^(<{7}|={7}|>{7})( |$)/m.test(bytes.toString("utf8")))
      throw new Error(`Unresolved conflict in ${file}; resolve its contents or choose an explicit conflict strategy`);
  }
}
