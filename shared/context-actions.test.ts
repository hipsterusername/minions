import { describe, expect, it } from "vitest";
import {
  defaultContextActions,
  invokeContextAction,
  normalizeContextActions,
  validateContextActionList,
} from "./context-actions.ts";

describe("context action contract", () => {
  it("distinguishes absent defaults from an intentionally empty list", () => {
    expect(normalizeContextActions(undefined)).toEqual(defaultContextActions());
    expect(normalizeContextActions({ dashboardLeaderActions: [] })).toEqual([]);
  });

  it("migrates legacy rows and stable-deduplicates skill ids", () => {
    expect(normalizeContextActions({ dashboardLeaderActions: [{
      id: "review", name: "Review", prompt: "Review this", icon: "search",
      skillIds: ["qa", " qa ", "docs"],
    }] })).toEqual([{
      id: "review", name: "Review", prompt: "Review this", icon: "search",
      skillIds: ["qa", "docs"],
    }]);
    expect(normalizeContextActions({ dashboardLeaderActions: [{
      id: "old", name: "Old", prompt: "Legacy", icon: "play",
    }] })).toEqual([{
      id: "old", name: "Old", prompt: "Legacy", icon: "play", skillIds: [],
    }]);
  });

  it("returns indexed validation issues", () => {
    const result = validateContextActionList([
      { id: "", name: "Name", prompt: "", icon: "play", skillIds: "bad" },
    ]);
    expect(result.actions).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 0, field: "id" }),
      expect.objectContaining({ index: 0, field: "prompt" }),
      expect.objectContaining({ index: 0, field: "skillIds" }),
    ]));
  });

  it("invokes additively while retaining unresolved skill ids as warnings", () => {
    expect(invokeContextAction(
      { prompt: "Do it", skillIds: ["review", "missing", "review"] },
      ["manual", "review"],
      ["review", "manual"],
    )).toEqual({
      prompt: "Do it",
      skillIds: ["manual", "review"],
      missingSkillIds: ["missing"],
    });
  });
});
