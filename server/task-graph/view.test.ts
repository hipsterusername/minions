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
    steeringEvents:[],invalidations:[],adjudications:[],usage:[],events:[],contextSources:[],...extra,
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
  it("does not project a legacy succeeded verification task without a passed verdict witness",()=>{
    const verificationTask=node("verification-task",{completionMode:"verification"});
    const facts=snapshot([verificationTask],[],{run:{...snapshot([verificationTask],[]).run,
      status:"blocked"},attempts:[{
      ...attempt("verifier-attempt","verification-task",1,"succeeded"),
      session_run_key:"child",source_snapshot_id:"source",
      terminal_witness_json:{source:"work_item_run",runKey:"child",
        finalReport:JSON.stringify({result:"failed",confidence:1}),
        completionVerdict:{result:"failed",confidence:1}},
    }]});

    const projected=projectedNode(projectTaskGraphSnapshot(facts,[],30),"verification-task");
    expect(projected).toMatchObject({logicalState:"failed",readiness:"terminal",
      currentAttempt:{state:"failed"},blocker:{category:"policy",
        explanation:"Verification needs Leader adjudication or a guided retry"}});
  });

  it("projects bounded authored briefs, visible frozen context, withheld sensitive sources, and final responses",()=>{
    const detailed=node("detailed",{
      objective:`Ship ${"x".repeat(9_000)}`,
      constraints:Array.from({length:60},(_,index)=>`constraint ${index} ${"c".repeat(2_100)}`),
      acceptanceCriteria:Array.from({length:60},(_,index)=>`criterion ${index} ${"a".repeat(2_100)}`),
    });
    const facts=snapshot([detailed],[],{
      attempts:[{...attempt("attempt","detailed",1,"succeeded"),
        final_report:`Completed ${"r".repeat(14_000)}`}],
      contextSources:[
        ...Array.from({length:18},(_,index)=>({nodeId:"detailed",sourceId:`visible-${index}`,
          contentHash:HASH,classification:index%2===0?"public":"internal",
          content:`Context ${index} ${"v".repeat(9_000)}`})),
        {nodeId:"detailed",sourceId:"credential",contentHash:HASH,
          classification:"secret",content:"never expose me"},
        {nodeId:"detailed",sourceId:"/srv/minions/context/private.json",contentHash:HASH,
          classification:"internal",content:"Path-safe content"},
        ...Array.from({length:5},(_,index)=>({nodeId:"detailed",sourceId:`trailing-${index}`,
          contentHash:HASH,classification:"internal",content:"trailing"})),
      ],
    });

    const view=projectTaskGraphSnapshot(facts,[],30);
    const projected=projectedNode(view,"detailed");

    expect(projected.objective).toHaveLength(8_000);
    expect(projected.constraints).toHaveLength(50);
    expect(projected.constraints[0]).toHaveLength(2_000);
    expect(projected.acceptanceCriteria).toHaveLength(50);
    expect(projected.context).toHaveLength(20);
    const firstContext=projected.context[0];
    expect(firstContext).toMatchObject({classification:"public",content:expect.any(String)});
    if (!firstContext || !("content" in firstContext)) throw new Error("expected visible context");
    expect(firstContext.content).toHaveLength(8_000);
    expect(projected.context.find(entry=>entry.sourceId==="credential"))
      .toEqual({sourceId:"credential",contentHash:HASH,classification:"secret",withheld:true});
    expect(projected.context.find(entry=>entry.sourceId==="source:aaaaaaaaaaaa"))
      .toMatchObject({classification:"internal",content:"Path-safe content"});
    expect(projected.currentAttempt?.response).toHaveLength(12_000);
    expect(JSON.stringify(projected)).not.toContain("never expose me");
    expect(JSON.stringify(projected)).not.toContain("/srv/minions");
  });

  it("redacts credential-shaped values from attempt final reports and witnesses",()=>{
    const task=node("response");
    const facts=snapshot([task],[],{attempts:[{
      ...attempt("response-attempt","response",1,"succeeded"),
      final_report:"Completed with Authorization: Bearer response-secret",
      terminal_witness_json:{finalReport:"api_key=witness-secret"},
    }]});

    const projected=projectedNode(projectTaskGraphSnapshot(facts,[],30),"response");
    expect(projected.currentAttempt?.response).toContain("Authorization: [REDACTED]");
    expect(projected.currentAttempt?.summary).toContain("api_key=[REDACTED]");
    expect(JSON.stringify(projected)).not.toMatch(/response-secret|witness-secret/);
  });

  it.each(["sensitive","secret"] as const)("withholds attempt text for %s outputs",classification=>{
    const task=node("response",{outputSchemas:{result:{type:"object"}}});
    const facts=snapshot([task],[],{
      attempts:[{...attempt("response-attempt","response",1,"succeeded"),
        final_report:"private response",terminal_witness_json:{finalReport:"private witness"}}],
      artifacts:[{...artifact("result","response","response-attempt"),
        metadata_json:JSON.stringify({classification})}],
    });

    const projected=projectedNode(projectTaskGraphSnapshot(facts,[],30),"response");
    expect(projected.currentAttempt?.response).toBeUndefined();
    expect(projected.currentAttempt?.summary).toBeUndefined();
    expect(JSON.stringify(projected)).not.toMatch(/private response|private witness/);
  });

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

  it.each(["sensitive","secret"] as const)("withholds verifier detail for %s evidence",classification=>{
    const verified=node("verified",{outputSchemas:{result:{type:"object"}},verificationRequired:true});
    const facts=snapshot([verified],[],{
      attempts:[attempt("producer","verified",1,"succeeded")],
      artifacts:[{...artifact("artifact","verified","producer"),
        metadata_json:JSON.stringify({classification})}],
      verifications:[{id:"verification",producer_attempt_id:"producer",
        verifier_attempt_id:"verifier",result:"failed",
        record_json:JSON.stringify({summary:"credential value must never appear"})}],
    });

    const projected=projectedNode(projectTaskGraphSnapshot(facts,[],30),"verified");
    expect(projected.verification.explanation).toBeUndefined();
    expect(projected.blocker?.explanation).toBe("Independent verification rejected the output");
    expect(JSON.stringify(projected)).not.toContain("credential value must never appear");
  });

  it("redacts credential-shaped values from visible verifier detail",()=>{
    const verified=node("verified",{outputSchemas:{result:{type:"object"}},verificationRequired:true});
    const summary=[
      "diagnostic: checksum mismatch remains readable",
      "api_key=supersecret",
      "OPENAI_API_KEY=environment-secret",
      "serviceApiKey=camel-secret",
      '"AWS_SECRET_ACCESS_KEY" = "aws-assignment-secret"',
      'client-secret: "another-secret"',
      "Authorization: Bearer bearer-value",
      "Basic basic-value",
      "Digest digest-value",
      "password='password-value'",
      `raw sk-${"a".repeat(24)}`,
      `github ghp_${"b".repeat(36)}`,
      `aws AKIA${"C".repeat(16)}`,
    ].join("; ");
    const facts=snapshot([verified],[],{
      attempts:[attempt("producer","verified",1,"succeeded")],
      artifacts:[artifact("artifact","verified","producer")],
      verifications:[{id:"verification",producer_attempt_id:"producer",
        verifier_attempt_id:"verifier",result:"failed",
        record_json:JSON.stringify({summary})}],
    });

    const projected=projectedNode(projectTaskGraphSnapshot(facts,[],30),"verified");
    expect(projected.verification.explanation).toContain("api_key=[REDACTED]");
    expect(projected.verification.explanation).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(projected.verification.explanation).toContain("serviceApiKey=[REDACTED]");
    expect(projected.verification.explanation).toContain('"AWS_SECRET_ACCESS_KEY" = [REDACTED]');
    expect(projected.verification.explanation).toContain("client-secret: [REDACTED]");
    expect(projected.verification.explanation).toContain("Authorization: [REDACTED]");
    expect(projected.verification.explanation).toContain("Basic [REDACTED]");
    expect(projected.verification.explanation).toContain("Digest [REDACTED]");
    expect(projected.verification.explanation).toContain("password=[REDACTED]");
    expect(projected.verification.explanation).toContain("raw [REDACTED]");
    expect(projected.verification.explanation).toContain("diagnostic: checksum mismatch remains readable");
    expect(projected.blocker?.explanation).toContain("api_key=[REDACTED]");
    expect(JSON.stringify(projected)).not.toMatch(
      /supersecret|environment-secret|camel-secret|aws-assignment-secret|another-secret|bearer-value|basic-value|digest-value|password-value|sk-a{24}|ghp_b{36}|AKIAC{16}/,
    );
  });

  it("keeps non-secret verifier diagnostics readable and bounded",()=>{
    const verified=node("verified",{outputSchemas:{result:{type:"object"}},verificationRequired:true});
    const facts=snapshot([verified],[],{
      attempts:[attempt("producer","verified",1,"succeeded")],
      artifacts:[artifact("artifact","verified","producer")],
      verifications:[{id:"verification",producer_attempt_id:"producer",
        verifier_attempt_id:"verifier",result:"failed",
        record_json:JSON.stringify({summary:`checksum mismatch: ${"detail ".repeat(300)}`})}],
    });

    const projected=projectedNode(projectTaskGraphSnapshot(facts,[],30),"verified");
    expect(projected.verification.explanation).toHaveLength(1_000);
    expect(projected.verification.explanation).toMatch(/^checksum mismatch: detail/);
    expect(projected.blocker?.explanation).toBe(
      `Independent verification rejected the output: ${projected.verification.explanation}`,
    );
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
