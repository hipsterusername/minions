import { globMatches } from "./match.ts";
import { describe, expect, it } from "vitest";
import { matchSystemModel } from "./match.ts";
import { loadSystemModel } from "./load.ts";
import { copyValidFixtureWithSurfaces } from "./load.test.ts";

describe("matchSystemModel", () => {
  it("scores deterministic top-K candidates with reason strings", () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const result = matchSystemModel({
      model,
      request: "worktree approve session",
      files: ["server/commands/approve-changes.ts"],
      topK: 2,
    });

    expect(result.matchConfidence).toBe("high");
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      "flow.approve_changes",
      "domain.workspace",
    ]);
    expect(result.candidates[0]?.reasons).toContain("file matched 1 suggested path");
  });

  it("scores every object type from its contract fields", () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;

    expect(matchSystemModel({ model, request: "workspace" }).candidates[0]).toMatchObject({
      id: "capability.workspace_management",
      type: "capability",
      score: 5,
      reasons: expect.arrayContaining(["name matched 1 term", "keyword matched 1 term"]),
    });
    expect(matchSystemModel({ model, request: "approve inspect" }).candidates[0]).toMatchObject({
      id: "flow.approve_changes",
      score: 7,
      reasons: expect.arrayContaining(["name matched 1 term", "flow matched 2 terms"]),
    });
    expect(matchSystemModel({ model, request: "outbound direct", files: ["server/commands/index.ts"] }).candidates[0]).toMatchObject({
      id: "constraint.bus_only",
      score: 9,
      reasons: expect.arrayContaining(["name matched 1 term", "instruction matched 1 term", "file matched 1 suggested path"]),
    });
    expect(matchSystemModel({ model, request: "typed payloads" }).candidates[0]).toMatchObject({
      id: "decision.bus_architecture",
      score: 5,
      reasons: expect.arrayContaining(["name matched 1 term", "summary matched 2 terms"]),
    });
    expect(matchSystemModel({ model, request: "centrally" }).candidates[0]).toMatchObject({
      id: "risk.merge_bypass",
      score: 1,
      reasons: expect.arrayContaining(["summary matched 1 term"]),
    });
  });

  it("applies topK after deterministic score and id ordering", () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const result = matchSystemModel({ model, request: "merge", topK: 1 });

    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      "flow.approve_changes",
    ]);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(
      [...result.candidates].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((candidate) => candidate.id),
    );
  });

  it("returns low confidence with fallback instruction when no candidate scores", () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const result = matchSystemModel({ model, request: "paint a canvas", files: ["src/App.tsx"] });

    expect(result.candidates).toEqual([]);
    expect(result.matchConfidence).toBe("low");
    expect(result.fallbackInstruction).toBe("inspect repo; ask only if required");
  });

  it("ranks surfaces and attributes capability entry-point file matches", () => {
    const model = loadSystemModel(copyValidFixtureWithSurfaces()).model!;
    expect(matchSystemModel({ model, request: "mobile" }).candidates[0]).toMatchObject({
      id: "surface.mobile",
      type: "surface",
      score: 6,
    });
    const capability = matchSystemModel({
      model,
      request: "unrelated",
      files: ["src/mobile/App.tsx"],
    }).candidates.find((candidate) => candidate.id === "capability.workspace_management");
    expect(capability).toMatchObject({
      score: 4,
      reasons: ["file matches entry point surface.mobile"],
    });
  });
});


describe("policy glob semantics", () => {
  it.each(["server/a.ts", "server/commands/remove.ts"])("matches %s under server/**/*.ts", file => {
    expect(globMatches("server/**/*.ts", file)).toBe(true);
  });
  it("keeps single-star matches within one directory", () => {
    expect(globMatches("server/*.ts", "server/bus.ts")).toBe(true);
    expect(globMatches("server/*.ts", "server/commands/remove.ts")).toBe(false);
    expect(globMatches("server/*.ts", "src/bus.ts")).toBe(false);
  });
});
