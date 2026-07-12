import { describe, expect, it } from "vitest";
import { loadSystemModel } from "./load.ts";
import { computeOverbreadth, validateLoadedSystemModel } from "./validate.ts";
import path from "path";

describe("validateLoadedSystemModel", () => {
  it("passes the valid fixture", () => {
    const { model } = loadSystemModel(path.resolve("tests/fixtures/system-model/valid"));
    expect(model).not.toBeNull();
    expect(validateLoadedSystemModel(model!)).toEqual([]);
  });

  it("reports overbreadth warnings with coverage", () => {
    const { model } = loadSystemModel(path.resolve("tests/fixtures/system-model/valid"));
    expect(model).not.toBeNull();
    const trackedFiles = [
      ...Array.from({ length: 9 }, (_, index) => `server/generated/file-${index}.ts`),
      "src/generated/file.tsx",
    ];

    expect(computeOverbreadth(model!, trackedFiles)).toContainEqual({
      objectId: "gate.review",
      kind: "gate",
      coverage: 0.9,
    });
    expect(validateLoadedSystemModel(model!, trackedFiles)).toContainEqual(expect.objectContaining({
      file: "gate.review",
      path: "requiredWhen.files",
      message: "Applicability globs cover 90.0% of tracked files",
      severity: "warning",
    }));
  });

  it("does not report overbreadth for narrow coverage", () => {
    const { model } = loadSystemModel(path.resolve("tests/fixtures/system-model/valid"));
    expect(model).not.toBeNull();
    const trackedFiles = [
      ...Array.from({ length: 3 }, (_, index) => `server/generated/file-${index}.ts`),
      ...Array.from({ length: 7 }, (_, index) => `src/generated/file-${index}.tsx`),
    ];

    expect(computeOverbreadth(model!, trackedFiles)).toEqual([]);
    expect(validateLoadedSystemModel(model!, trackedFiles).filter((error) => "severity" in error)).toEqual([]);
  });

  it("accepts current gate references when this checkout has a project model", () => {
    const { model, errors } = loadSystemModel(process.cwd());
    if (errors.some((error) => error.message === "manifest.yaml not found")) {
      expect(model).toBeNull();
      return;
    }
    expect(errors.filter((error) => error.message.includes("Unknown review gate"))).toEqual([]);
    expect(model).not.toBeNull();
  });
});
