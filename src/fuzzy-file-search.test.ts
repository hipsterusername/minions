import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzySearchFiles } from "./fuzzy-file-search.ts";

describe("fuzzyMatch", () => {
  it("returns null when not all query chars appear in order", () => {
    expect(fuzzyMatch("xyz", "src/foo.ts")).toBeNull();
    expect(fuzzyMatch("ofs", "src/foo.ts")).toBeNull(); // 'f' must follow 'o'
  });

  it("matches a contiguous substring inside the path", () => {
    const m = fuzzyMatch("foo", "src/foo.ts");
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([4, 5, 6]);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("LDR", "src/nodes/LeaderNode.tsx")).not.toBeNull();
    expect(fuzzyMatch("ldr", "src/nodes/LeaderNode.tsx")).not.toBeNull();
  });

  it("scores word-boundary matches higher than mid-word matches", () => {
    const boundary = fuzzyMatch("fb", "foo/bar.ts")!;
    const midword = fuzzyMatch("fb", "afoobar.ts")!;
    expect(boundary.score).toBeGreaterThan(midword.score);
  });

  it("scores consecutive runs higher than scattered matches", () => {
    const run = fuzzyMatch("foo", "foo.ts")!;
    const scattered = fuzzyMatch("foo", "f_o_o.ts")!;
    expect(run.score).toBeGreaterThan(scattered.score);
  });

  it("prefers basename matches over directory-name matches", () => {
    const inBase = fuzzyMatch("util", "lib/util.ts")!;
    const inDir = fuzzyMatch("util", "util/lib.ts")!;
    expect(inBase.score).toBeGreaterThan(inDir.score);
  });

  it("recognises camelCase humps as boundaries", () => {
    const hump = fuzzyMatch("ln", "LeaderNode.tsx")!;
    const nohump = fuzzyMatch("ln", "leadernode.tsx")!;
    expect(hump.score).toBeGreaterThan(nohump.score);
  });

  it("returns a zero-score match for an empty query", () => {
    const m = fuzzyMatch("", "anything.ts");
    expect(m).toEqual({ path: "anything.ts", score: 0, indices: [] });
  });
});

describe("fuzzySearchFiles", () => {
  const files = [
    "src/nodes/LeaderNode.tsx",
    "src/nodes/MinionNode.tsx",
    "src/Canvas.tsx",
    "src/canvas-state.ts",
    "src/fuzzy-file-search.ts",
    "tests/contracts/projects-files-routes.test.ts",
    "README.md",
    "package.json",
  ];

  it("returns [] for an empty query", () => {
    expect(fuzzySearchFiles("", files)).toEqual([]);
  });

  it("filters out non-matching candidates", () => {
    const results = fuzzySearchFiles("zzz", files);
    expect(results).toEqual([]);
  });

  it("ranks the most relevant file first", () => {
    const results = fuzzySearchFiles("ldrnd", files);
    expect(results[0]!.path).toBe("src/nodes/LeaderNode.tsx");
  });

  it("ranks an exact basename match above a partial directory match", () => {
    const results = fuzzySearchFiles("canvas", files);
    expect(results[0]!.path).toBe("src/Canvas.tsx");
  });

  it("respects the limit parameter", () => {
    const results = fuzzySearchFiles("s", files, 3);
    expect(results.length).toBe(3);
  });

  it("uses path length as a tiebreaker when scores match", () => {
    // Identical scoring shape (both word-boundary basename matches in the
    // same directory); the shorter path wins.
    const results = fuzzySearchFiles("x", ["lib/xx.ts", "lib/x.ts"]);
    expect(results[0]!.path).toBe("lib/x.ts");
  });
});
