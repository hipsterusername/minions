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
    expect(errors.some((error) => error.message.includes("flow.missing"))).toBe(true);
  });
});

export function copyValidFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "system-model-"));
  fs.cpSync(path.join(fixtures, "valid"), dir, { recursive: true });
  return dir;
}
