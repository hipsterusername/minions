import { describe, it, expect } from "vitest";
import {
  DIALECTIC_MODES,
  DEFAULT_DIALECTIC_ROUNDS,
  MIN_DIALECTIC_ROUNDS,
  MAX_DIALECTIC_ROUNDS,
  isDialecticMode,
  normalizeRounds,
  createDefaultDialecticConfig,
  normalizeDialecticConfig,
  resolveSynthesisPlanner,
  dialecticSessionKeys,
} from "./dialectic.ts";

describe("dialectic mode registry", () => {
  it("exposes exactly the three configurable modes", () => {
    expect(DIALECTIC_MODES.map((m) => m.id)).toEqual([
      "ping-pong",
      "proposer-critic",
      "debate-synthesis",
    ]);
  });

  it("recognizes valid modes and rejects others", () => {
    expect(isDialecticMode("ping-pong")).toBe(true);
    expect(isDialecticMode("proposer-critic")).toBe(true);
    expect(isDialecticMode("nonsense")).toBe(false);
    expect(isDialecticMode(42)).toBe(false);
  });
});

describe("normalizeRounds", () => {
  it("defaults non-numbers", () => {
    expect(normalizeRounds(undefined)).toBe(DEFAULT_DIALECTIC_ROUNDS);
    expect(normalizeRounds("3")).toBe(DEFAULT_DIALECTIC_ROUNDS);
    expect(normalizeRounds(NaN)).toBe(DEFAULT_DIALECTIC_ROUNDS);
  });

  it("clamps to the supported range and rounds to integer", () => {
    expect(normalizeRounds(0)).toBe(MIN_DIALECTIC_ROUNDS);
    expect(normalizeRounds(-5)).toBe(MIN_DIALECTIC_ROUNDS);
    expect(normalizeRounds(100)).toBe(MAX_DIALECTIC_ROUNDS);
    expect(normalizeRounds(2.6)).toBe(3);
  });
});

describe("normalizeDialecticConfig", () => {
  it("fills defaults for empty/garbage input", () => {
    expect(normalizeDialecticConfig(undefined)).toEqual(createDefaultDialecticConfig());
    expect(normalizeDialecticConfig(null)).toEqual(createDefaultDialecticConfig());
    expect(normalizeDialecticConfig("x")).toEqual(createDefaultDialecticConfig());
  });

  it("preserves valid fields and clamps rounds", () => {
    const cfg = normalizeDialecticConfig({
      mode: "proposer-critic",
      rounds: 99,
      plannerA: { harness: "claude", model: "claude-opus-4-8" },
      plannerB: { harness: "claude", model: "claude-sonnet-5" },
    });
    expect(cfg.mode).toBe("proposer-critic");
    expect(cfg.rounds).toBe(MAX_DIALECTIC_ROUNDS);
    expect(cfg.plannerA.model).toBe("claude-opus-4-8");
    expect(cfg.plannerB.model).toBe("claude-sonnet-5");
    expect(cfg.synthesis).toBeUndefined();
  });

  it("drops planners missing a model", () => {
    const cfg = normalizeDialecticConfig({
      plannerA: { harness: "claude" },
    });
    // falls back to default planner A
    expect(cfg.plannerA).toEqual(createDefaultDialecticConfig().plannerA);
  });

  it("keeps an explicit synthesis planner when provided", () => {
    const cfg = normalizeDialecticConfig({
      synthesis: { harness: "claude", model: "claude-opus-4-8" },
    });
    expect(cfg.synthesis).toEqual({ harness: "claude", model: "claude-opus-4-8" });
  });
});

describe("resolveSynthesisPlanner", () => {
  it("falls back to planner A when synthesis is unset", () => {
    const cfg = createDefaultDialecticConfig();
    cfg.plannerA = { harness: "claude", model: "claude-opus-4-8" };
    expect(resolveSynthesisPlanner(cfg)).toEqual(cfg.plannerA);
  });

  it("uses the explicit synthesis planner when set", () => {
    const cfg = createDefaultDialecticConfig();
    cfg.synthesis = { harness: "claude", model: "claude-haiku-4-5" };
    expect(resolveSynthesisPlanner(cfg)).toEqual(cfg.synthesis);
  });
});

describe("dialecticSessionKeys", () => {
  it("derives distinct, deterministic keys from a node id", () => {
    const keys = dialecticSessionKeys("node1");
    expect(keys).toEqual({
      coordinator: "dialectic-node1",
      plannerA: "dialectic-node1-A",
      plannerB: "dialectic-node1-B",
      synthesis: "dialectic-node1-S",
    });
    // A and B are always distinct — the "two distinct sessions" guarantee.
    expect(keys.plannerA).not.toBe(keys.plannerB);
  });
});
