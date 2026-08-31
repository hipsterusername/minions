import "./test-helpers.ts";
import { describe, expect, it } from "vitest";
import { semanticTaskGraphPlanSchema } from "../../shared/task-graph-planning-contracts.ts";
import {
  TASK_GRAPH_ANALYTICAL_ARTIFACT_SCHEMAS,
  TASK_GRAPH_PATTERN_CATALOG,
} from "../../shared/task-graph-patterns.ts";
import { validateArtifactContract } from "./artifact-contract.ts";
import { lintSemanticGraphPlan, routeTaskGraphPattern } from "./patterns.ts";

function plan(raw: Record<string, unknown> = {}) {
  return semanticTaskGraphPlanSchema.parse({
    objective:"Reach a verified outcome",acceptanceCriteria:["Outcome is delivered"],
    steps:[{key:"deliver",title:"Deliver",objective:"Deliver the outcome",
      acceptanceCriteria:["Outcome is delivered"]}],
    ...raw,
  });
}

describe("task graph pattern router", () => {
  it("recommends direct execution for one bounded unit", () => {
    expect(routeTaskGraphPattern(plan())).toMatchObject({
      id:"p00.direct",version:1,source:"expanded_topology",
    });
  });

  it("prefers problem semantics over incidental topology", () => {
    expect(routeTaskGraphPattern(plan({
      problemSignature:{taskKind:"diagnosis"},
    }))).toMatchObject({ id:"p10.causal_diagnosis",source:"problem_signature" });
    expect(routeTaskGraphPattern(plan({
      problemSignature:{taskKind:"decision",deepUncertainty:true},
    }))).toMatchObject({ id:"p14.scenario_stress_test",source:"problem_signature" });
  });

  it("routes every problem-signature strategy deterministically", () => {
    const cases = [
      [{deepUncertainty:true},"p14.scenario_stress_test"],
      [{taskKind:"diagnosis"},"p10.causal_diagnosis"],
      [{taskKind:"decision"},"p11.value_focused_decision"],
      [{taskKind:"comparison"},"p12.multi_criteria_scorecard"],
      [{taskKind:"dialectic"},"p13.dialectic"],
      [{taskKind:"search"},"p09.hypothesis_tournament"],
      [{taskKind:"design",goalClarity:"ambiguous"},"p18.double_diamond"],
      [{taskKind:"schedule"},"p16.critical_path_delivery"],
      [{taskKind:"partitioned_batch"},"p03.static_scatter_gather"],
      [{taskKind:"draft_refinement"},"p08.generate_critique_revise_verify"],
      [{procedure:"hierarchical"},"p15.hierarchical_decomposition"],
      [{taskKind:"research",evidenceModes:"multiple"},"p06.evidence_triangulation"],
      [{verificationNeed:"independent"},"p07.independent_verification"],
      [{decomposability:"high"},"p02.fork_join"],
    ] as const;
    for (const [problemSignature,id] of cases) {
      expect(routeTaskGraphPattern(plan({problemSignature}))).toMatchObject({
        id,source:"problem_signature",
      });
    }
  });

  it("recognizes quorum and survivorship joins from expanded plans", () => {
    const branches=["a","b"].map(key=>({key,title:key,objective:`Attempt ${key}`,
      acceptanceCriteria:[`${key} completes`],outputSchemas:{result:{type:"object"}}}));
    const quorum=plan({steps:[...branches,{key:"join",title:"Join",objective:"Aggregate",
      acceptanceCriteria:["Outcome is delivered"],inputBindings:{a:{type:"object"},b:{type:"object"}},
      dependsOn:branches.map(branch=>({stepKey:branch.key,kind:"artifact",sourceOutput:"result",
        targetInput:branch.key,satisfactionPolicy:"quorum",quorum:1,failurePolicy:"skip"}))}]});
    expect(routeTaskGraphPattern(quorum).id).toBe("p04.quorum_ensemble");

    const survivorship=plan({steps:[...branches,{key:"join",title:"Join",objective:"Synthesize",
      acceptanceCriteria:["Outcome is delivered","Coverage and missing evidence are disclosed"],
      inputBindings:{a:{type:"object"},b:{type:"object"}},dependsOn:[
        ...branches.map(branch=>({stepKey:branch.key,kind:"control",satisfactionPolicy:"all_terminal",
          failurePolicy:"skip"})),
        ...branches.map(branch=>({stepKey:branch.key,kind:"artifact",sourceOutput:"result",
          targetInput:branch.key,optional:true})),
      ]}]});
    expect(routeTaskGraphPattern(survivorship).id).toBe("p05.survivorship_synthesis");
  });

  it("has a deterministic recommendation path for every catalog pattern", () => {
    const signaturePlans = [
      {deepUncertainty:true},{taskKind:"diagnosis"},{taskKind:"decision"},
      {taskKind:"comparison"},{taskKind:"dialectic"},{taskKind:"search"},
      {taskKind:"design",goalClarity:"ambiguous"},
      {taskKind:"schedule"},{taskKind:"partitioned_batch"},{taskKind:"draft_refinement"},
      {procedure:"hierarchical"},{taskKind:"research",evidenceModes:"multiple"},
      {verificationNeed:"independent"},{decomposability:"high"},
    ].map(problemSignature=>plan({problemSignature}));
    const pipeline=plan({steps:[
      {key:"a",title:"A",objective:"Start",acceptanceCriteria:["A completes"]},
      {key:"b",title:"B",objective:"Finish",acceptanceCriteria:["Outcome is delivered"],
        dependsOn:[{stepKey:"a"}]},
    ]});
    const branches=["a","b"].map(key=>({key,title:key,objective:`Attempt ${key}`,
      acceptanceCriteria:[`${key} completes`],outputSchemas:{result:{type:"object"}}}));
    const quorum=plan({steps:[...branches,{key:"join",title:"Join",objective:"Aggregate",
      acceptanceCriteria:["Outcome is delivered","Coverage is disclosed"],
      inputBindings:{a:{type:"object"},b:{type:"object"}},
      dependsOn:branches.map(branch=>({stepKey:branch.key,kind:"artifact",sourceOutput:"result",
        targetInput:branch.key,satisfactionPolicy:"quorum",quorum:1,failurePolicy:"skip"}))}]});
    const survivorship=plan({steps:[...branches,{key:"join",title:"Join",objective:"Synthesize",
      acceptanceCriteria:["Outcome is delivered","Coverage and missing evidence are disclosed"],
      inputBindings:{a:{type:"object"},b:{type:"object"}},dependsOn:[
        ...branches.map(branch=>({stepKey:branch.key,kind:"control",satisfactionPolicy:"all_terminal",
          failurePolicy:"skip"})),
        ...branches.map(branch=>({stepKey:branch.key,kind:"artifact",sourceOutput:"result",
          targetInput:branch.key,optional:true})),
      ]}]});
    const recommendations=[plan(),pipeline,quorum,survivorship,...signaturePlans]
      .map(value=>routeTaskGraphPattern(value).id);
    expect(new Set(recommendations)).toEqual(new Set(TASK_GRAPH_PATTERN_CATALOG.map(item=>item.id)));
  });
});

describe("task graph pattern lint", () => {
  it("reports graph theater and successor provenance without blocking old plans", () => {
    const findings=lintSemanticGraphPlan(plan(),{baseProposalRevision:1});
    expect(findings.map(finding=>finding.code)).toEqual(expect.arrayContaining([
      "graph_theater","iteration_provenance",
    ]));
  });

  it("reports weak contracts, correlated quorum branches, and missing partial coverage", () => {
    const branches=["a","b"].map(key=>({key,title:key,objective:"Use the same method",
      acceptanceCriteria:[`${key} completes`],outputSchemas:{result:{}}}));
    const value=plan({pattern:{id:"p04.quorum_ensemble",version:1},steps:[...branches,{
      key:"join",title:"Join",objective:"Aggregate",acceptanceCriteria:["Outcome is delivered"],
      inputBindings:{a:{},b:{}},dependsOn:branches.map(branch=>({stepKey:branch.key,
        kind:"artifact",sourceOutput:"result",targetInput:branch.key,
        satisfactionPolicy:"quorum",quorum:1,failurePolicy:"skip"})),
    }]});
    expect(lintSemanticGraphPlan(value).map(finding=>finding.code)).toEqual(expect.arrayContaining([
      "weak_artifact_contract","correlated_ensemble","partial_coverage",
    ]));
  });

  it("reports selected-pattern conformance and bounded-search stop rules", () => {
    const value=plan({pattern:{id:"p09.hypothesis_tournament",version:1}});
    expect(lintSemanticGraphPlan(value).map(finding=>finding.code))
      .toContain("missing_stop_rule");
    expect(lintSemanticGraphPlan(plan({pattern:{id:"p07.independent_verification",version:1}}))
      .map(finding=>finding.code)).toContain("pattern_conformance");
  });

  it("validates every analytical artifact's accepted example", () => {
    for (const schema of Object.values(TASK_GRAPH_ANALYTICAL_ARTIFACT_SCHEMAS)) {
      expect(() => validateArtifactContract(schema.example,schema)).not.toThrow();
    }
  });
});
