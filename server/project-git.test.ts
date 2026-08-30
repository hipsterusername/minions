import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeProjectGit, inspectProjectGit } from "./project-git.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "minions-project-git-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("project Git initialization", () => {
  it("initializes, stages files, and creates the first commit", async () => {
    const projectPath = path.join(root, "project");
    const calls: string[][] = [];

    await initializeProjectGit(projectPath, {
      inspect: () => ({ isRepository: false }),
      runGit: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "var") throw new Error("identity missing");
        if (args[0] === "init") fs.mkdirSync(path.join(projectPath, ".git"));
        return "";
      },
    });

    expect(calls).toEqual([
      ["var", "GIT_AUTHOR_IDENT"],
      ["init"],
      ["add", "-A"],
      [
        "-c", "user.name=Minions",
        "-c", "user.email=minions@localhost",
        "-c", "commit.gpgSign=false",
        "commit", "--allow-empty", "--no-verify", "-m", "Initial commit",
      ],
    ]);
  });

  it("recognizes nested paths inside the current repository", () => {
    expect(inspectProjectGit(path.join(process.cwd(), "future", "nested"))).toEqual({ isRepository: true });
  });

  it("does not reinitialize an existing repository", async () => {
    let gitCalls = 0;
    await initializeProjectGit(root, {
      inspect: () => ({ isRepository: true }),
      runGit: async () => {
        gitCalls += 1;
        return "";
      },
    });

    expect(gitCalls).toBe(0);
  });
});
