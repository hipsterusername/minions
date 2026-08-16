import "./test-helpers.ts";
import { describe,expect,it } from "vitest";
import type { GraphSnapshot,TaskEdge,TaskNode } from "../../shared/task-graph-contracts.ts";
import type { NodeReadiness } from "./readiness.ts";
import { projectTaskGraphSnapshot } from "./view.ts";

const HASH=`sha256:${"a".repeat(64)}`;

function node(id:string,extra:Partial<TaskNode>={}):TaskNode {
  return {id,title:id,objective:`do ${id}`,inputBindings:{},outputSchemas:{},constraints:[],
    acceptanceCriteria:[],executorClass:"standard",allowedHarnesses:["codex"],allowedTools:[],
    ownershipRequest:[],budgetRequest:{},timeoutMs:1_000,
    retryPolicy:{maxAttempts:3,backoffMs:0,retryableOutcomes:["failed","lost"],jitterMs:0},
    verificationRequired:false,failurePolicy:"fail_graph",expansionPolicy:null,...extra};
}

function edge(id:string,sourceNodeId:string,targetNodeId:string,extra:Partial<TaskEdge>={}):TaskEdge {
  return {id,sourceNodeId,targetNodeId,kind:"control",sourceOutput:null,targetInput:null,
    satisfactionPolicy:"all_success",failurePolicy:"fail",optional:false,...extra};
}

function snapshot(nodes:TaskNode[],edges:TaskEdge[],extra:Partial<GraphSnapshot>={}):GraphSnapshot {
  return {
    run:{id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshotId:"source",status:"active",paused:false,revision:4,maxActiveAttempts:4,
      createdAt:10,updatedAt:20},
    revision:{definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",
      objective:"inspect graph",acceptanceCriteria:["done"],nonGoals:[],constraints:[],
      terminalNodeIds:[nodes.at(-1)!.id],nodes,edges,maxActiveAttempts:4},
    sourceSnapshot:{id:"source",workItemId:"work",primaryRunKey:"primary",taskGraphRevisionId:"revision",
      repositoryBaseCommit:"abc",dirtyDiffDigest:HASH,workspaceId:"workspace",worktreeIdentity:"wt",
      systemModelDigest:HASH,workPacketRevisionId:null,connectedContext:[],compiledSkills:[],
      harnessPolicyDigest:HASH,toolPolicyDigest:HASH,createdAt:1},
    attempts:[],artifacts:[],verifications:[],verificationRequests:[],humanInputs:[],edgeEvaluations:[],
    reservations:[],joins:[],outbox:[],schedulerLease:null,expansions:[],reductions:[],reconciliations:[],
    steeringEvents:[],invalidations:[],usage:[],events:[],...extra,
  };
}

function attempt(id:string,nodeId:string,attemptNumber:number,outcome:string) {
  return {id,node_id:nodeId,attempt_number:attemptNumber,runtime:"terminal",outcome,
    created_at:11,updated_at:12};
}

function artifact(id:string,nodeId:string,producerAttemptId:string,outputName="result") {
  return {id,node_id:nodeId,producer_attempt_id:producerAttemptId,state:"committed",output_name:outputName,
    source_snapshot_id:"source"};
}

function projectedNode(view:ReturnType<typeof projectTaskGraphSnapshot>,id:string) {
  return view.nodes.find(item=>item.id===id)!;
}

describe("projectTaskGraphSnapshot logical projection",()=>{
  it("uses live readiness to distinguish manual retries from terminal nonretryable outcomes",()=>{
    const granted=node("granted",{retryPolicy:{maxAttempts:2,backoffMs:0,
      retryableOutcomes:["failed"],jitterMs:0}});
    const rejected=node("rejected",{retryPolicy:{maxAttempts:5,backoffMs:0,
      retryableOutcomes:["lost"],jitterMs:0}});
    const exhausted=node("exhausted",{retryPolicy:{maxAttempts:2,backoffMs:0,
      retryableOutcomes:["failed"],jitterMs:0}});
    const facts=snapshot([granted,rejected,exhausted],[],{attempts:[
      attempt("granted-2","granted",2,"failed"),attempt("rejected-1","rejected",1,"failed"),
      attempt("exhausted-2","exhausted",2,"failed"),
    ]});
    const readiness:NodeReadiness[]=[
      {nodeId:"granted",ready:true,reason:"ready"},
      {nodeId:"rejected",ready:false,reason:"outcome_not_retryable"},
      {nodeId:"exhausted",ready:false,reason:"attempts_exhausted"},
    ];

    const view=projectTaskGraphSnapshot(facts,readiness,30);

    expect(projectedNode(view,"granted")).toMatchObject({logicalState:"pending",readiness:"ready"});
    expect(projectedNode(view,"rejected")).toMatchObject({logicalState:"failed",readiness:"terminal",
      blocker:{category:"policy",explanation:"outcome not retryable"}});
    expect(projectedNode(view,"exhausted")).toMatchObject({logicalState:"exhausted",readiness:"terminal"});
  });

  it("projects an inconclusive verification as an actionable policy failure",()=>{
    const verified=node("verified",{outputSchemas:{result:{type:"object"}},verificationRequired:true});
    const facts=snapshot([verified],[],{
      attempts:[attempt("producer","verified",1,"succeeded")],
      artifacts:[artifact("artifact","verified","producer")],
      verifications:[{id:"verification",producer_attempt_id:"producer",
        verifier_attempt_id:"verifier",result:"inconclusive"}],
      verificationRequests:[{node_id:"verified",status:"completed",result:"inconclusive"}],
    });
    const view=projectTaskGraphSnapshot(facts,[{
      nodeId:"verified",ready:false,reason:"attempt_succeeded_pending_satisfaction",
    }],30);

    expect(projectedNode(view,"verified")).toMatchObject({
      verification:{state:"failed",explanation:"Independent verifier could not produce a conclusive verdict"},
      blocker:{category:"policy",explanation:"Independent verification was inconclusive"},
    });
  });

  it("binds current inputs and outputs to exact current producers while retaining stale lineage",()=>{
    const producer=node("producer",{outputSchemas:{result:{type:"object"}}});
    const invalid=node("invalid",{outputSchemas:{result:{type:"object"}}});
    const consumer=node("consumer");
    const facts=snapshot([producer,invalid,consumer],[
      edge("producer-consumer","producer","consumer",{kind:"artifact",sourceOutput:"result",targetInput:"a"}),
      edge("invalid-consumer","invalid","consumer",{kind:"artifact",sourceOutput:"result",targetInput:"b"}),
    ],{
      attempts:[attempt("producer-1","producer",1,"succeeded"),attempt("producer-2","producer",2,"succeeded"),
        attempt("invalid-1","invalid",1,"succeeded")],
      artifacts:[artifact("old","producer","producer-1"),artifact("current","producer","producer-2"),
        artifact("invalidated","invalid","invalid-1")],
      invalidations:[{invalidated_attempt_id:"invalid-1"}],
    });
    const readiness:NodeReadiness[]=[
      {nodeId:"producer",ready:false,reason:"attempt_succeeded_pending_satisfaction"},
      {nodeId:"invalid",ready:true,reason:"ready"},
      {nodeId:"consumer",ready:false,reason:"join_unsatisfied:1/2"},
    ];

    const view=projectTaskGraphSnapshot(facts,readiness,30);

    expect(projectedNode(view,"producer").outputArtifactIds).toEqual(["current"]);
    expect(projectedNode(view,"invalid").outputArtifactIds).toEqual([]);
    expect(projectedNode(view,"consumer").inputIds).toEqual(["current"]);
    expect(view.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({artifactId:"old",status:"stale"}),
      expect.objectContaining({artifactId:"invalidated",status:"stale"}),
    ]));
  });

  it("projects required timeout-weighted critical edges, terminal failures, and actual group cost",()=>{
    const a=node("a",{timeoutMs:100});
    const a2=node("a2",{timeoutMs:100});
    const a3=node("a3",{timeoutMs:100});
    const b=node("b",{timeoutMs:2_000});
    const c=node("c",{timeoutMs:3_000});
    const optional=node("optional",{timeoutMs:20_000});
    const failed=node("failed",{timeoutMs:50,retryPolicy:{maxAttempts:4,backoffMs:0,
      retryableOutcomes:["lost"],jitterMs:0}});
    const terminal=node("terminal",{timeoutMs:500});
    const facts=snapshot([a,a2,a3,b,c,optional,failed,terminal],[
      edge("a-a2","a","a2"),edge("a2-a3","a2","a3"),edge("a3-terminal","a3","terminal"),
      edge("b-c","b","c"),edge("c-terminal","c","terminal"),
      edge("optional-terminal","optional","terminal",{optional:true}),edge("failed-terminal","failed","terminal"),
    ],{
      attempts:[attempt("failed-1","failed",1,"failed")],
      edgeEvaluations:[{edge_id:"a3-terminal",satisfied:0},{edge_id:"b-c",satisfied:0},
        {edge_id:"failed-terminal",satisfied:0}],
      usage:[{node_id:"b",attempt_id:"b-1",cost_usd:1.25,tokens:10},
        {node_id:"c",attempt_id:"c-1",cost_usd:0.75,tokens:20},
        {node_id:"failed",attempt_id:"failed-1",cost_usd:0.5,tokens:5}],
    });
    const readiness:NodeReadiness[]=[{nodeId:"failed",ready:false,reason:"outcome_not_retryable"}];

    const view=projectTaskGraphSnapshot(facts,readiness,30);
    const edgeStates=Object.fromEntries(view.edges.map(item=>[item.id,item.state]));

    expect(view.criticalPath.nodeIds).toEqual(["b","c","terminal"]);
    expect(edgeStates).toMatchObject({"a3-terminal":"ordinary","b-c":"critical","c-terminal":"critical",
      "optional-terminal":"ordinary","failed-terminal":"failure"});
    expect(view.groups.find(group=>group.id==="executor:standard")?.costUsd).toBe(2.5);
  });
});
