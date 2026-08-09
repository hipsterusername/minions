import { describe, expect, it } from "vitest";
import { contextBudgetSchema, reviewGateSchema } from "./policies.ts";

describe("system-model policy schemas", () => {
  it("applies context budget defaults", () => {
    expect(contextBudgetSchema.parse({}).minionContextPack).toBe(2000);
  });

  it("validates review gates", () => {
    const gate = reviewGateSchema.parse({
      id: "gate.review",
      name: "Review",
      blocksMerge: true,
    });
    expect(gate.requiredWhen.files).toEqual([]);
    expect(() => reviewGateSchema.parse({ id: "review", name: "Bad" })).toThrow();
  });
});
