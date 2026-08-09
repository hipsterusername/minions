import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");

function listServerFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
    }
  }
  walk(SERVER_DIR);
  return out;
}

describe("architecture: task lifecycle authority", () => {
  it("does not assign task.status directly outside server/task-lifecycle.ts", () => {
    const offenders = listServerFiles()
      .filter((file) => !file.endsWith(join("server", "task-lifecycle.ts")))
      .flatMap((file) => {
        const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
        return readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ rel, line, lineNo: index + 1 }))
          .filter(({ line }) => /\b(?:\w+\.)?task\.status\s*=(?!=)/.test(line));
      });

    expect(offenders).toEqual([]);
  });
});
