import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { loadSystemModel } from "./load.ts";

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

export function copyValidFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "system-model-"));
  process.env["MINIONS_HOME"] = fs.mkdtempSync(path.join(os.tmpdir(), "system-model-home-"));
  fs.cpSync(path.join(fixtures, "valid"), dir, { recursive: true });
  return dir;
}

export function copyValidFixtureWithSurfaces(): string {
  const dir = copyValidFixture();
  const root = path.join(dir, ".systemmodel");
  fs.mkdirSync(path.join(root, "surfaces"));
  fs.writeFileSync(path.join(root, "surfaces/canvas.yaml"), surfaceYaml("canvas", "src/Canvas.tsx"));
  fs.writeFileSync(path.join(root, "surfaces/mobile.yaml"), surfaceYaml("mobile", "src/mobile/**"));
  fs.appendFileSync(path.join(root, "capabilities/workspace.yaml"), `\nentry_points:\n  - surface: surface.canvas\n    summary: Canvas approval\n    files:\n      - src/Canvas.tsx\n    tests:\n      - src/Canvas.test.tsx\n    flows:\n      - flow.approve_changes\n  - surface: surface.mobile\n    files: [src/mobile/**]\n    tests: [src/mobile/app.test.ts]\n    flows: [flow.approve_changes]\n`);
  return dir;
}

function surfaceYaml(id: string, file: string): string {
  return `id: surface.${id}\ntype: surface\nname: ${id}\nsummary: ${id} surface\nkeywords: [${id}]\nsuggested_files: [${file}]\n`;
}
