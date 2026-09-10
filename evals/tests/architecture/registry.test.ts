import { describe, expect, it } from "vitest";
import { ExtensionRegistry, assertParticipantSafePath } from "../../src/core/index.js";
describe("extension registry", () => {
  it("keys extensions by version and fails unknown extensions explicitly", () => {
    const registry = new ExtensionRegistry<{ id: string; version: string }>;
    registry.register({ id: "adapter.fixture", version: "1.0.0" });
    expect(registry.get("adapter.fixture", "1.0.0").id).toBe("adapter.fixture");
    expect(() => registry.get("adapter.fixture", "2.0.0")).toThrow(/unknown extension/);
    expect(() => registry.register({ id: "adapter.fixture", version: "1.0.0" })).toThrow(/already registered/);
  });
  it("rejects escaping participant-visible paths", () => {
    expect(() => assertParticipantSafePath("../oracle.json")).toThrow(/unsafe/);
    expect(() => assertParticipantSafePath("src/index.ts")).not.toThrow();
  });
});
