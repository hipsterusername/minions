import { describe, expect, it } from "vitest";
import { agentSpawnDedupKey, claimSpawnEvent } from "./spawn-event.ts";

describe("spawn event coordination", () => {
  it("keeps an early event retryable until its parent Leader is hydrated", () => {
    const claimed = new Set<string>();

    expect(claimSpawnEvent(claimed, "minion-1", false)).toBe(false);
    expect(claimed).not.toContain("minion-1");
    expect(claimSpawnEvent(claimed, "minion-1", true)).toBe(true);
  });

  it("claims a spawn exactly once after the parent is present", () => {
    const claimed = new Set<string>();

    expect(claimSpawnEvent(claimed, "minion-1", true)).toBe(true);
    expect(claimSpawnEvent(claimed, "minion-1", true)).toBe(false);
    expect(claimed).toEqual(new Set(["minion-1"]));
  });

  it("names SDK sub-agent claims independently from session keys", () => {
    expect(agentSpawnDedupKey("task-7")).toBe("agent-task-7");
  });
});
