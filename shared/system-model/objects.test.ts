import { describe, expect, it } from "vitest";
import {
  capabilitySchema,
  constraintSchema,
  decisionMetaSchema,
  flowSchema,
  riskSchema,
} from "./objects.ts";

describe("system-model object schemas", () => {
  it("accepts valid object fixtures", () => {
    expect(capabilitySchema.parse({
      id: "capability.workspace_management",
      type: "capability",
      name: "Workspace",
      summary: "Manage worktrees.",
    }).linkedFlows).toEqual([]);
    expect(flowSchema.parse({
      id: "flow.approve_changes",
      type: "flow",
      name: "Approve",
      summary: "Approve changes.",
    }).risk).toBe("medium");
    expect(constraintSchema.parse({
      id: "constraint.bus_only",
      type: "constraint",
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
      summary: "Bypass",
      severity: "high",
    }).appliesTo.files).toEqual([]);
  });

  it("rejects invalid ids", () => {
    expect(() => capabilitySchema.parse({
      id: "cap.bad",
      type: "capability",
      name: "Bad",
      summary: "Bad",
    })).toThrow();
  });
});
