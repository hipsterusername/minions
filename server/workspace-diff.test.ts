import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "./worktree-exec.ts";
import { getWorkspaceDiff } from "./workspace-diff.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "leader-changes-"));
  roots.push(root);
  await exec(["init", "-b", "main"], root);
  await exec(["config", "user.name", "Test"], root);
  await exec(["config", "user.email", "test@example.test"], root);
  return root;
}

describe("live workspace changes", () => {
  it("reports staged, unstaged, deleted, binary and untracked files without changing the index", async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, "modified.txt"), "old\n");
    await fs.writeFile(path.join(root, "deleted.txt"), "removed\n");
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await exec(["add", "."], root);
    await exec(["commit", "-m", "initial"], root);
    await fs.writeFile(path.join(root, "modified.txt"), "new\nextra\n");
    await fs.unlink(path.join(root, "deleted.txt"));
    await fs.writeFile(path.join(root, "staged.txt"), "staged\n");
    await exec(["add", "staged.txt"], root);
    await fs.writeFile(path.join(root, "new\tfile.txt"), "untracked\n");
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(root, "ignored.txt"), "ignored\n");
    const before = await exec(["status", "--porcelain=v1", "-z"], root);
    const diff = await getWorkspaceDiff(root);
    expect(diff).toMatchObject({ filesChanged: 5, insertions: 4, deletions: 2, commits: [], branch: "main" });
    expect(diff.files).toEqual(expect.arrayContaining([
      { file: "modified.txt", status: "modified", insertions: 2, deletions: 1 },
      { file: "deleted.txt", status: "deleted", insertions: 0, deletions: 1 },
      { file: "staged.txt", status: "added", insertions: 1, deletions: 0 },
      { file: "new\tfile.txt", status: "added", insertions: 1, deletions: 0 },
      { file: "binary.bin", status: "added", insertions: 0, deletions: 0 },
    ]));
    expect(await exec(["status", "--porcelain=v1", "-z"], root)).toEqual(before);
  });

  it("includes files before the first commit and reads from the repository root", async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "staged.txt"), "initial\n");
    await exec(["add", "staged.txt"], root);
    await fs.writeFile(path.join(root, "staged.txt"), "initial\nmore\n");
    await fs.writeFile(path.join(root, "new.txt"), "new\n");
    expect(await getWorkspaceDiff(path.join(root, "nested"))).toMatchObject({ filesChanged: 2, insertions: 3, deletions: 0 });
  });

  it("returns an empty diff for a clean repository and reports non-repository errors", async () => {
    const root = await repo();
    await exec(["commit", "--allow-empty", "-m", "initial"], root);
    expect(await getWorkspaceDiff(root)).toMatchObject({ filesChanged: 0, files: [] });
    await fs.rm(path.join(root, ".git"), { recursive: true });
    await expect(getWorkspaceDiff(root)).rejects.toThrow("git rev-parse");
  });
});
