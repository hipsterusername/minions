import "./test-helpers.ts";
import { describe, expect, it } from "vitest";
import type { SemanticTaskGraphPlan } from "../../shared/task-graph-planning-contracts.ts";
import { compileSemanticGraphPlan } from "./planning-compiler.ts";

function plan(): SemanticTaskGraphPlan {
  return {
    objective: "Ship graph planning",
    acceptanceCriteria: ["The implementation is verified"],
    nonGoals: [], constraints: [], assumptions: [], questions: [], maxActiveAttempts: 4,
    steps: [
      { key: "inspect", title: "Inspect", objective: "Inspect the code",
        acceptanceCriteria: ["Seams are documented"], constraints: [], dependsOn: [],
        contextSelectors: ["runtime"], inputBindings: {}, outputSchemas: { report: { type: "object" } },
        executorClass: "reasoning", ownershipRequest: [], budgetRequest: {}, timeoutMs: 30_000,
        retryPolicy: { maxAttempts: 2, backoffMs: 0, retryableOutcomes: ["failed"], jitterMs: 0 },
        verificationRequired: false, failurePolicy: "fail_graph", risk: "low", requiresApproval: false },
      { key: "build", title: "Build", objective: "Implement the change",
        acceptanceCriteria: ["Tests pass"], constraints: [],
        dependsOn: [{ stepKey: "inspect", kind: "artifact", sourceOutput: "report",
          targetInput: "analysis", optional: false, failurePolicy: "block" }],
        contextSelectors: [], inputBindings: { analysis: { type: "object" } },
        outputSchemas: { result: { type: "object" } },
        executorClass: "standard", ownershipRequest: [], budgetRequest: {}, timeoutMs: 30_000,
        retryPolicy: { maxAttempts: 2, backoffMs: 0, retryableOutcomes: ["failed"], jitterMs: 0 },
        verificationRequired: true, failurePolicy: "fail_graph", risk: "low", requiresApproval: false },
    ],
  };
}

function compile(value = plan()) {
  return compileSemanticGraphPlan({ workItemId: "work", workspaceId: "workspace",
    primaryRunKey: "primary", proposalRevision: 1, plan: value,
    defaultHarness: "codex", defaultAllowedTools: ["Read", "Glob"] });
}

describe("semantic graph-plan compiler", () => {
  it("generates deterministic canonical topology and typed artifact edges", () => {
    const first = compile();
    const second = compile();
    expect(first).toEqual(second);
    expect(first.revision.revisionId).toMatch(/^revision_[a-f0-9]{32}$/);
    expect(first.revision.terminalNodeIds).toEqual([first.nodeIdsByStepKey["build"]]);
    expect(first.revision.edges[0]).toMatchObject({ kind: "artifact", sourceOutput: "report",
      targetInput: "analysis" });
    expect(first.autoStartEligible).toBe(true);
  });

  it("rejects unordered parallel steps with overlapping write ownership", () => {
    const value = plan();
    value.steps = value.steps.map((step) => ({ ...step, dependsOn: [], ownershipRequest: [{
      scope: "path" as const, mode: "write" as const,
      normalizedValue: step.key === "inspect" ? "server" : "server/task-graph",
    }] }));
    expect(() => compile(value)).toThrow("overlapping writes");
  });

  it("requires every step to reach an explicit terminal deliverable", () => {
    const value = plan();
    value.terminalStepKeys = ["inspect"];
    expect(() => compile(value)).toThrow("cannot reach a terminal deliverable");
  });

  it("does not auto-start plans with risk, approval, or unanswered questions", () => {
    const value = plan();
    value.steps[0] = { ...value.steps[0]!, risk: "medium", requiresApproval: true };
    expect(compile(value).autoStartEligible).toBe(false);
  });
});
