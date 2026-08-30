import fs from "node:fs";
import path from "node:path";

export interface ProjectGitStatus {
  isRepository: boolean;
}

function nearestExistingDirectory(projectPath: string): string {
  let candidate = projectPath;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

export interface ProjectGitRuntime {
  inspect: typeof inspectProjectGit;
  runGit: typeof git;
}

const defaultRuntime: ProjectGitRuntime = { inspect: inspectProjectGit, runGit: git };

export function inspectProjectGit(projectPath: string): ProjectGitStatus {
  let candidate = nearestExistingDirectory(projectPath);
  while (true) {
    if (fs.existsSync(path.join(candidate, ".git"))) return { isRepository: true };
    const parent = path.dirname(candidate);
    if (parent === candidate) return { isRepository: false };
    candidate = parent;
  }
}

export async function initializeProjectGit(
  projectPath: string,
  runtime: ProjectGitRuntime = defaultRuntime,
): Promise<void> {
  const current = runtime.inspect(projectPath);
  if (current.isRepository) return;

  fs.mkdirSync(projectPath, { recursive: true });
  let identityArgs: string[] = [];
  try {
    await runtime.runGit(projectPath, ["var", "GIT_AUTHOR_IDENT"]);
  } catch {
    identityArgs = ["-c", "user.name=Minions", "-c", "user.email=minions@localhost"];
  }

  const gitDirectory = path.join(projectPath, ".git");
  const gitDirectoryExisted = fs.existsSync(gitDirectory);
  try {
    await runtime.runGit(projectPath, ["init"]);
    await runtime.runGit(projectPath, ["add", "-A"]);
    await runtime.runGit(projectPath, [
      ...identityArgs,
      "-c", "commit.gpgSign=false",
      "commit", "--allow-empty", "--no-verify", "-m", "Initial commit",
    ]);
  } catch (error) {
    if (!gitDirectoryExisted) fs.rmSync(gitDirectory, { recursive: true, force: true });
    throw error;
  }
}
