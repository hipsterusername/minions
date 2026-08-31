import { describe,expect,it } from "vitest";
import { compileSemanticGraphPlan } from "../task-graph/planning-compiler.ts";
import { lintSemanticGraphPlan,routeTaskGraphPattern } from "../task-graph/patterns.ts";
import { buildDialecticGraphPlan } from "./graph-plan.ts";

describe("dialectic graph plan",()=>{
  it("expands bounded turns, synthesis checkpoints, and Leader gates",()=>{
    const plan=buildDialecticGraphPlan({requestId:"dialectic-1",baseProposalRevision:null,
      objective:"Choose a safe migration strategy",mode:"proposer-critic",rounds:4,
      checkpointEvery:2,participantA:{},participantB:{},synthesizer:{},contextSelectors:[]});

    expect(plan.pattern).toEqual({id:"p13.dialectic",version:1});
    expect(plan.steps.map(step=>step.key)).toEqual([
      "turn-a-1","turn-b-1","turn-a-2","turn-b-2","synthesis-2",
      "turn-a-3","turn-b-3","turn-a-4","turn-b-4","synthesis-4",
    ]);
    expect(plan.terminalStepKeys).toEqual(["synthesis-4"]);
    expect(plan.maxActiveAttempts).toBe(1);
    expect(plan.steps.find(step=>step.key==="turn-a-3")?.dependsOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({stepKey:"synthesis-2",kind:"artifact"}),
        expect.objectContaining({stepKey:"synthesis-2",kind:"human_gate"}),
      ]),
    );
    expect(plan.steps.find(step=>step.key==="synthesis-2")?.reasoning)
      .toMatchObject({phase:"synthesis",round:2,final:false});
    expect(plan.steps.find(step=>step.key==="synthesis-4")?.reasoning)
      .toMatchObject({phase:"synthesis",round:4,final:true});
  });

  it("keeps participant threads stable while differentiating roles and default tiers",()=>{
    const plan=buildDialecticGraphPlan({requestId:"dialectic-2",baseProposalRevision:null,
      objective:"Stress-test the architecture",mode:"ping-pong",rounds:3,checkpointEvery:1,
      participantA:{harness:"codex",model:"model-a"},
      participantB:{harness:"codex",model:"model-b"},synthesizer:{harness:"codex"},
      contextSelectors:["repo:server"]});
    const a=plan.steps.filter(step=>step.reasoning?.participantId==="A");
    const b=plan.steps.filter(step=>step.reasoning?.participantId==="B");
    expect(a.map(step=>step.sessionAffinity?.sequence)).toEqual([0,1,2]);
    expect(b.map(step=>step.sessionAffinity?.sequence)).toEqual([0,1,2]);
    expect(new Set(a.map(step=>step.sessionAffinity?.key))).toEqual(new Set(["dialectic:A"]));
    expect(a[0]).toMatchObject({executorClass:"reasoning",model:"model-a"});
    expect(b[0]).toMatchObject({executorClass:"standard",model:"model-b"});
    expect(a[0]?.reasoning?.role).not.toBe(b[0]?.reasoning?.role);
    expect(a.every(step=>JSON.stringify(step.outputSchemas)===JSON.stringify(a[0]!.outputSchemas)))
      .toBe(true);
  });

  it("compiles through the ordinary immutable graph runtime with dialectic conformance",()=>{
    const plan=buildDialecticGraphPlan({requestId:"dialectic-3",baseProposalRevision:null,
      objective:"Resolve a difficult design tradeoff",mode:"debate-synthesis",rounds:2,
      checkpointEvery:1,participantA:{},participantB:{},synthesizer:{},contextSelectors:[]});
    expect(routeTaskGraphPattern(plan).id).toBe("p13.dialectic");
    expect(lintSemanticGraphPlan(plan).filter(item=>item.code==="pattern_conformance"))
      .toEqual([]);
    const compiled=compileSemanticGraphPlan({workItemId:"work",workspaceId:"workspace",
      primaryRunKey:"primary",proposalRevision:1,plan,defaultHarness:"codex",
      defaultAllowedTools:[]});
    expect(compiled.autoStartEligible).toBe(true);
    expect(compiled.revision.edges.some(edge=>edge.kind==="human_gate")).toBe(true);
    expect(compiled.revision.nodes.find(node=>node.reasoning?.phase==="turn"))
      .toHaveProperty("sessionAffinity");
  });

  it("rejects an unbounded checkpoint interval and identical roles",()=>{
    expect(()=>buildDialecticGraphPlan({requestId:"bad-interval",baseProposalRevision:null,
      objective:"x",mode:"ping-pong",rounds:2,checkpointEvery:3,
      participantA:{},participantB:{},synthesizer:{},contextSelectors:[]})).toThrow(
      "checkpointEvery cannot exceed",
    );
    expect(()=>buildDialecticGraphPlan({requestId:"bad-roles",baseProposalRevision:null,
      objective:"x",mode:"ping-pong",rounds:2,checkpointEvery:1,
      participantA:{role:"same"},participantB:{role:"same"},synthesizer:{},
      contextSelectors:[]})).toThrow("roles must be materially different");
  });
});
