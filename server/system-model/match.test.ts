import { describe, expect, it } from "vitest";
import { matchSystemModel } from "./match.ts";
import { loadSystemModel } from "./load.ts";

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
      "capability.workspace_management",
    ]);
    expect(result.candidates[0]?.reasons).toContain("file matched 1 suggested path");
  });

  it("returns low confidence with fallback instruction when no candidate scores", () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const result = matchSystemModel({ model, request: "paint a canvas", files: ["src/App.tsx"] });

    expect(result.candidates).toEqual([]);
    expect(result.matchConfidence).toBe("low");
    expect(result.fallbackInstruction).toBe("inspect repo; ask only if required");
  });
});
