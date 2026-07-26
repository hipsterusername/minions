import { describe, expect, it } from "vitest";
import {
  capabilitySchema,
  constraintSchema,
  decisionMetaSchema,
  flowSchema,
  riskSchema,
  surfaceSchema,
  domainSchema,
} from "./objects.ts";

describe("system-model object schemas", () => {
  it("accepts valid object fixtures", () => {
    expect(capabilitySchema.parse({
      id: "capability.workspace_management",
      type: "capability",
      domain: "domain.workspace",
      name: "Workspace",
      summary: "Manage worktrees.",
    }).dependsOn).toEqual([]);
    expect(capabilitySchema.parse({
      id: "capability.entry_points",
      type: "capability",
      domain: "domain.workspace",
      name: "Entry points",
      summary: "Works across surfaces.",
      entryPoints: [{ surface: "surface.mobile" }],
    }).entryPoints[0]).toEqual({
      surface: "surface.mobile", files: [], tests: [], flows: [],
    });
    expect(flowSchema.parse({
      id: "flow.approve_changes",
      type: "flow",
      domain: "domain.workspace",
      primaryCapability: "capability.workspace_management",
      name: "Approve",
      summary: "Approve changes.",
    }).risk).toBe("medium");
    expect(constraintSchema.parse({
      id: "constraint.bus_only",
      type: "constraint",
      domain: "domain.workspace",
      scope: "targeted",
      guards: ["capability.workspace_management"],
      statement: "Use the bus.",
      appliesTo: { capabilities: [], flows: [], files: [] },
      severity: "critical",
    }).severity).toBe("critical");
    expect(decisionMetaSchema.parse({
      id: "decision.bus_architecture",
      type: "decision",
      title: "Bus",
      summary: "Use Bus.",
    }).status).toBe("accepted");
    expect(riskSchema.parse({
      id: "risk.merge_bypass",
      type: "risk",
      domain: "domain.workspace",
      summary: "Bypass",
      severity: "high",
    }).appliesTo.files).toEqual([]);
    expect(domainSchema.parse({
      id: "domain.workspace",
      type: "domain",
      name: "Workspace",
      summary: "Workspace behavior.",
      keywords: ["workspace"],
    }).keywords).toEqual(["workspace"]);
    expect(surfaceSchema.parse({
      id: "surface.mobile",
      type: "surface",
      name: "Mobile",
      summary: "Mobile application.",
    }).suggestedFiles).toEqual([]);
  });

  it("rejects invalid ids", () => {
    expect(() => capabilitySchema.parse({
      id: "cap.bad",
      type: "capability",
      domain: "domain.workspace",
      name: "Bad",
      summary: "Bad",
    })).toThrow();
  });

  it("rejects an empty bridge reason", () => {
    expect(() => capabilitySchema.parse({
      id: "capability.workspace",
      type: "capability",
      domain: "domain.workspace",
      name: "Workspace",
      summary: "Workspace behavior.",
      bridges: [{ to: "flow.sync", reason: "   " }],
    })).toThrow("Bridge reason must be non-empty");
  });

  it("rejects the removed linked_flows capability shape", () => {
    expect(capabilitySchema.safeParse({
      id: "capability.workspace",
      type: "capability",
      domain: "domain.workspace",
      name: "Workspace",
      summary: "Workspace behavior.",
      linkedFlows: ["flow.sync"],
    }).success).toBe(false);
  });
});
