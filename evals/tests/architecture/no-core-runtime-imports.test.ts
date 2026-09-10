import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []))).flat();
}
describe("standalone package boundary", () => {
  it("does not import application source trees at runtime", async () => {
    const files = (await Promise.all(["src", "schemas"].map((directory) => sourceFiles(join(process.cwd(), directory))))).flat();
    const forbidden = /from\s+["'][^"']*(?:\.\.\/){1,}(?:src|server|shared)\/|from\s+["'](?:src|server|shared)\//;
    await Promise.all(files.map(async (file) => expect(await readFile(file, "utf8"), file).not.toMatch(forbidden)));
  });
});
