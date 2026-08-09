import { execFile as execFileCb } from "node:child_process";

// ── Shared helpers for worktree modules ────────────────────────────────────

export const WORKTREE_DIR = ".canvas-worktrees";

export function exec(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(`git ${args[0]}: ${msg}`));
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
}
