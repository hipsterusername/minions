import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("architecture: design-token regressions", () => {
  it("does not build translucent colors with hex-alpha string concatenation", () => {
    const minionNode = readRepoFile("src/nodes/MinionNode.tsx");

    expect(minionNode.match(/\$\{[^}]+}\s*cc/g) ?? []).toEqual([]);
  });

  it("does not mix render progress indicators with hard-coded white", () => {
    const renderNode = readRepoFile("src/nodes/RenderNode.tsx");

    expect(renderNode.match(/color-mix\(in srgb,[^)]*\bwhite\b/gi) ?? []).toEqual([]);
    expect(renderNode.match(/rgba\(255\s*,\s*255\s*,\s*255/gi) ?? []).toEqual([]);
  });

  it("keeps the leader prompt action flat and accent-contrast safe", () => {
    const promptBar = readRepoFile("src/nodes/leader/prompt/LeaderPromptBar.tsx");

    expect(promptBar).not.toContain("var(--gradient-primary)");
    expect(promptBar).toContain("var(--text-on-accent)");
  });
});
