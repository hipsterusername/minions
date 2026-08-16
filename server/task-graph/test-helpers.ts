import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const originalMinionsHome = process.env["MINIONS_HOME"];
const temporaryPaths: string[] = [];

export const taskGraphTestHome = makeTaskGraphTempDir("minions-task-graph-home-");
process.env["MINIONS_HOME"] = taskGraphTestHome;

export function makeTaskGraphTempDir(prefix = "minions-task-graph-"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

afterAll(() => {
  if (originalMinionsHome === undefined) delete process.env["MINIONS_HOME"];
  else process.env["MINIONS_HOME"] = originalMinionsHome;

  for (const directory of temporaryPaths.reverse()) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
