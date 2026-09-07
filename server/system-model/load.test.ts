import path from "path";
import { describe, expect, it } from "vitest";
import { loadSystemModel } from "./load.ts";
import { copyValidFixtureWithSurfaces } from "../../tests/support/system-model-fixture.ts";

const fixtures = path.resolve(process.cwd(), "tests/fixtures/system-model");

describe("loadSystemModel", () => {
  it("loads a valid .systemmodel tree", () => {
    const { model, errors } = loadSystemModel(path.join(fixtures, "valid"));
    expect(errors).toEqual([]);
    expect(model?.capabilities).toHaveLength(1);
    expect(model?.objectsById.has("constraint.bus_only")).toBe(true);
    expect(model?.policies.reviewGates[0]?.id).toBe("gate.review");
  });

  it("returns precise errors for malformed YAML", () => {
    const { model, errors } = loadSystemModel(path.join(fixtures, "bad-yaml"));
    expect(model).toBeNull();
    expect(errors[0]?.file).toContain("bad.yaml");
    expect(errors[0]?.message).toContain("Expected key");
  });

  it("returns validation errors for dangling refs", () => {
    const { model, errors } = loadSystemModel(path.join(fixtures, "dangling"));
    expect(model).toBeNull();
    expect(errors.some((error) => error.message.includes("capability.missing"))).toBe(true);
  });

  it("loads surfaces and nested capability entry points", () => {
    const project = copyValidFixtureWithSurfaces();
    const { model, errors } = loadSystemModel(project);
    expect(errors).toEqual([]);
    expect(model?.surfaces.map((surface) => surface.id)).toEqual([
      "surface.canvas", "surface.mobile",
    ]);
    expect(model?.capabilities[0]?.entryPoints[0]).toEqual({
      surface: "surface.canvas",
      summary: "Canvas approval",
      files: ["src/Canvas.tsx"],
      tests: ["src/Canvas.test.tsx"],
      flows: ["flow.approve_changes"],
    });
  });
});
