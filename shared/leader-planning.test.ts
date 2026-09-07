import { describe, expect, it } from "vitest";
import { normalizeLeaderOrchestrationMode } from "./leader-planning.ts";

describe("Leader Graph orchestration", () => {
  it.each([undefined, "direct", "legacy", "auto", "future-mode"])(
    "normalizes %s to always-enabled Graph execution", (mode) => {
      expect(normalizeLeaderOrchestrationMode(mode)).toBe("auto");
    },
  );
  it("preserves explicit graph review", () => {
    expect(normalizeLeaderOrchestrationMode("plan")).toBe("plan");
  });
});
