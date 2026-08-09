import { describe, expect, it } from "vitest";
import { loadSystemModel } from "./load.ts";
import { computeOverbreadth, validateLoadedSystemModel } from "./validate.ts";
import path from "path";
import { copyValidFixtureWithSurfaces } from "./load.test.ts";

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

  it("does not require the live checkout to use the new breaking schema during fixture acceptance", () => {
    const { model, errors } = loadSystemModel(process.cwd());
    if (errors.some((error) => error.message === "manifest.yaml not found")) {
      expect(model).toBeNull();
      return;
    }
    expect(errors.filter((error) => error.message.includes("Unknown review gate"))).toEqual([]);
    if (model) expect(validateLoadedSystemModel(model).filter((error) => error.message.includes("Unknown review gate"))).toEqual([]);
  });

  it("enforces constraint scope tightness with stable messages", () => {
    const { model } = loadSystemModel(path.resolve("tests/fixtures/system-model/valid"));
    const constraint = model!.constraints[0]!;
    constraint.scope = "targeted";
    constraint.guards = [];
    expect(validateLoadedSystemModel(model!)).toContainEqual(expect.objectContaining({
      path: "guards",
      message: "Targeted constraint constraint.bus_only must declare at least one guard",
    }));

    constraint.scope = "global";
    constraint.guards = ["capability.workspace_management"];
    expect(validateLoadedSystemModel(model!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Global constraint constraint.bus_only must not declare guards" }),
      expect.objectContaining({ message: "Global constraint constraint.bus_only must not declare explicit applies_to object links" }),
      expect.objectContaining({ message: "Global constraint constraint.bus_only must not be explicitly referenced by capability.workspace_management" }),
    ]));
  });

  it("requires bridges for cross-domain primary, dependency, and guard relations", () => {
    const { model } = loadSystemModel(path.resolve("tests/fixtures/system-model/valid"));
    const otherDomain = { id: "domain.other", type: "domain" as const, name: "Other", summary: "Other behavior.", keywords: ["other"] };
    const otherCapability = {
      ...model!.capabilities[0]!, id: "capability.other", domain: otherDomain.id,
      dependsOn: ["capability.workspace_management"], constraints: [], bridges: [], entryPoints: [],
    };
    model!.domains.push(otherDomain);
    model!.capabilities.push(otherCapability);
    model!.objectsById.set(otherDomain.id, otherDomain);
    model!.objectsById.set(otherCapability.id, otherCapability);
    model!.flows[0]!.domain = otherDomain.id;
    model!.constraints[0]!.domain = otherDomain.id;

    expect(validateLoadedSystemModel(model!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Cross-domain depends_on reference from capability.other to capability.workspace_management requires a bridge to capability.workspace_management" }),
      expect.objectContaining({ message: "Cross-domain primary_capability reference from flow.approve_changes to capability.workspace_management requires a bridge to capability.workspace_management" }),
      expect.objectContaining({ message: "Cross-domain guards reference from constraint.bus_only to capability.workspace_management requires a bridge from capability.workspace_management to constraint.bus_only" }),
    ]));
  });

  it("validates entry-point and surface references and duplicate pairs", () => {
    const { model } = loadSystemModel(copyValidFixtureWithSurfaces());
    expect(model).not.toBeNull();
    model!.capabilities[0]!.entryPoints.push({
      surface: "surface.canvas", files: [], tests: [], flows: ["flow.missing"],
    });
    model!.capabilities[0]!.entryPoints.push({
      surface: "surface.missing", files: [], tests: [], flows: [],
    });
    model!.constraints[0]!.appliesTo.surfaces.push("surface.constraint_missing");
    model!.risks[0]!.appliesTo.surfaces.push("surface.risk_missing");
    const errors = validateLoadedSystemModel(model!);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Duplicate entry point for surface.canvas" }),
      expect.objectContaining({ message: "Unknown reference flow.missing" }),
      expect.objectContaining({ message: "Unknown reference surface.missing" }),
      expect.objectContaining({ message: "Unknown reference surface.constraint_missing" }),
      expect.objectContaining({ message: "Unknown reference surface.risk_missing" }),
    ]));
  });
});
