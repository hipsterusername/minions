import "./test-helpers.ts";
import { describe, expect, it } from "vitest";
import type { AgentHarness } from "../harness/types.ts";
import type { SemanticTaskGraphPlan } from "../../shared/task-graph-planning-contracts.ts";
import { compileSemanticGraphPlan } from "./planning-compiler.ts";
import { validateTaskGraphNodePolicy } from "./execution-policy.ts";

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
          targetInput: "analysis", satisfactionPolicy:"all_success",
          optional: false, failurePolicy: "block" }],
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
    expect(first.revision.nodes.map(node=>node.completionMode)).toEqual(["task","task"]);
  });

  it("keeps pattern metadata declarative and out of runtime policy",()=>{
    const value={...plan(),pattern:{id:"p07.independent_verification" as const,version:1 as const},
      iteration:{strategy:"single_episode" as const,episode:1,evidenceRefs:[]}};
    const compiled=compile(value);
    expect(compiled.revision.nodes.every(node=>node.expansionPolicy===null)).toBe(true);
    expect(compiled.revision.edges).toHaveLength(1);
    expect(compiled.revision.edges[0]).toMatchObject({
      kind:"artifact",satisfactionPolicy:"all_success",failurePolicy:"block",
    });
    expect(compiled.revision).not.toHaveProperty("pattern");
    expect(compiled.revision).not.toHaveProperty("iteration");
  });

  it("keeps legacy auto-start behavior but holds an opted-in direct recommendation for review",()=>{
    const legacy=plan();legacy.steps=[legacy.steps[0]!];
    expect(compile(legacy).autoStartEligible).toBe(true);
    const routed={...legacy,problemSignature:{taskKind:"delivery" as const,
      goalClarity:"explicit" as const,procedure:"known" as const,decomposability:"low" as const,
      evidenceModes:"single" as const,alternatives:"one" as const,deepUncertainty:false,
      verificationNeed:"ordinary" as const}};
    expect(compile(routed).autoStartEligible).toBe(false);
  });

  it("rejects undeclared artifact bindings with semantic step names", () => {
    const missingOutput = plan();
    missingOutput.steps[0] = { ...missingOutput.steps[0]!, outputSchemas: {} };
    expect(() => compile(missingOutput))
      .toThrow(/sourceOutput.*report.*inspect.*outputSchemas/);

    const missingInput = plan();
    missingInput.steps[1] = { ...missingInput.steps[1]!, inputBindings: {} };
    expect(() => compile(missingInput))
      .toThrow(/targetInput.*analysis.*build.*inputBindings/);
  });

  it("requires ordering-only dependencies to omit artifact bindings", () => {
    const value = plan();
    value.steps[1]!.dependsOn = [{ ...value.steps[1]!.dependsOn[0]!, kind: "control" }];
    expect(() => compile(value)).toThrow(
      "control dependencies cannot declare artifact bindings",
    );
  });

  it("materializes explicit quorum joins for partial synthesis",()=>{
    const value=plan();
    value.steps[1]!.dependsOn[0]={...value.steps[1]!.dependsOn[0]!,
      satisfactionPolicy:"quorum",quorum:1,failurePolicy:"skip"};
    expect(compile(value).revision.edges[0]).toMatchObject({
      satisfactionPolicy:"quorum",quorum:1,failurePolicy:"skip",
    });
  });

  it("preflights the accepted output example against its declared schema",()=>{
    const invalid=plan();
    invalid.steps[0]!.outputSchemas.report={type:"string",pattern:"^audit$"};
    invalid.steps[1]!.inputBindings.analysis={type:"string"};
    expect(()=>compile(invalid)).toThrow(/output report has no valid accepted example/);

    invalid.steps[0]!.outputSchemas.report={type:"string",pattern:"^audit$",example:"audit"};
    expect(()=>compile(invalid)).not.toThrow();
  });

  it("accepts omitted tool restrictions for a harness with native filesystem access",()=>{
    const codex=({name:"codex",builtInTools:[],capabilities:{mutationInterception:"observe_only",
      builtInFilesystem:true,
      sandboxEnforcement:{filesystem:["read-only","workspace-write"],approval:true}}}) as unknown as AgentHarness;
    const compileForCodex=(value:SemanticTaskGraphPlan)=>compileSemanticGraphPlan({
      workItemId:"work",workspaceId:"workspace",primaryRunKey:"primary",proposalRevision:1,
      plan:value,defaultHarness:"codex",defaultAllowedTools:[],
      validateNodePolicy:(node)=>validateTaskGraphNodePolicy(node,()=>codex),
    });
    expect(()=>compileForCodex(plan())).not.toThrow();
    const guessed=plan();
    guessed.steps[0]={...guessed.steps[0]!,allowedTools:["shell"]};
    expect(()=>compileForCodex(guessed))
      .toThrow("omit allowedTools to inherit harness-native shell/filesystem access");
  });

  it("preserves verification-task completion separately from artifact verification",()=>{
    const value=plan();
    value.steps[0]={...value.steps[0]!,completionMode:"verification",verificationRequired:false};
    const compiled=compile(value);
    expect(compiled.revision.nodes[0]).toMatchObject({
      completionMode:"verification",verificationRequired:false,
    });
    expect(compiled.revision.nodes[1]).toMatchObject({
      completionMode:"task",verificationRequired:true,
    });
  });

  it("defaults verification failures to a recoverable Leader decision",()=>{
    const value=plan();
    value.steps[0]={...value.steps[0]!,completionMode:"verification",failurePolicy:undefined};
    value.steps[1]={...value.steps[1]!,failurePolicy:undefined};
    const compiled=compile(value);
    expect(compiled.revision.nodes[0]?.failurePolicy).toBe("block_for_decision");
    expect(compiled.revision.nodes[1]?.failurePolicy).toBe("fail_graph");

    value.steps[0]={...value.steps[0]!,failurePolicy:"fail_graph"};
    expect(compile(value).revision.nodes[0]?.failurePolicy).toBe("fail_graph");
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

  it.each(["medium", "high"] as const)("auto-starts plans with %s-risk steps", (risk) => {
    const value = plan();
    value.steps[0] = { ...value.steps[0]!, risk };
    expect(compile(value).autoStartEligible).toBe(true);
  });

  it("does not auto-start plans with an explicit step approval", () => {
    const value = plan();
    value.steps[0] = { ...value.steps[0]!, requiresApproval: true };
    expect(compile(value).autoStartEligible).toBe(false);
  });

  it("does not auto-start plans with unanswered questions", () => {
    const value = plan();
    value.questions = ["Which API should be changed?"];
    expect(compile(value).autoStartEligible).toBe(false);
  });
});
