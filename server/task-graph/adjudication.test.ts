import "./test-helpers.ts";
import {describe,expect,it,vi} from "vitest";
import type {Bus} from "../bus.ts";
import {initDb} from "../db.ts";
import {createWorkItem,startWorkItemIteration} from "../work-item-repo.ts";
import {ensureWorkItemSchema} from "../work-item-schema.ts";
import type {GraphRevisionInput,SourceSnapshot} from "../../shared/task-graph-contracts.ts";
import type {WorkItemRunSnapshot} from "../../shared/work-item-contracts.ts";
import type {WsEnvelope} from "../../shared/ws-envelope.ts";
import {TaskGraphConflictError,TaskGraphValidationError} from "./errors.ts";
import {TaskGraphService} from "./service.ts";
import {taskGraphArtifactsForSession} from "./artifact-access.ts";

const HASH=`sha256:${"a".repeat(64)}`;

function setup() {
  const db=initDb(":memory:");ensureWorkItemSchema(db);
  createWorkItem(db,{id:"work",projectId:"project",projectPath:process.cwd(),title:"Work",
    changeMode:"live",at:1});
  startWorkItemIteration(db,{workItemId:"work",runKey:"primary",idempotencyKey:"primary",
    expectedLifecycleRevision:0,expectedCurrentRunKey:null,at:2});
  return db;
}

function revision(completionMode:"task"|"verification"="verification",
  downstream=false,withOutput=false):GraphRevisionInput {
  const verify:GraphRevisionInput["nodes"][number]={id:"verify",title:"Verify",
    objective:"Run checks",inputBindings:{},outputSchemas:withOutput?{result:{type:"object"}}:{},constraints:[],
    acceptanceCriteria:["all checks pass"],executorClass:"reasoning",allowedHarnesses:["codex"],
    allowedTools:[],ownershipRequest:[],budgetRequest:{},timeoutMs:30_000,
    retryPolicy:{maxAttempts:1,backoffMs:0,retryableOutcomes:["failed"],jitterMs:0},
    completionMode,verificationRequired:false,failurePolicy:"block_for_decision",expansionPolicy:null};
  const next:GraphRevisionInput["nodes"][number]={...verify,id:"next",title:"Continue",
    objective:"Continue after verification",acceptanceCriteria:["work continues"],
    inputBindings:withOutput?{result:{type:"object"}}:{},outputSchemas:{},
    completionMode:"task",failurePolicy:"fail_graph"};
  return {definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",
    objective:"Verify the repair",acceptanceCriteria:["checks pass"],nonGoals:[],constraints:[],
    terminalNodeIds:[downstream?"next":"verify"],maxActiveAttempts:1,
    edges:downstream?[{id:"verify-next",sourceNodeId:"verify",targetNodeId:"next",
      kind:withOutput?"artifact":"control",sourceOutput:withOutput?"result":null,
      targetInput:withOutput?"result":null,satisfactionPolicy:"all_success",
      optional:false,failurePolicy:"block"}]:[],nodes:downstream?[verify,next]:[verify]};
}

function source():SourceSnapshot {
  return {id:"source",workItemId:"work",primaryRunKey:"primary",taskGraphRevisionId:"revision",
    repositoryBaseCommit:"abc",dirtyDiffDigest:HASH,workspaceId:"workspace",worktreeIdentity:"wt",
    systemModelDigest:HASH,workPacketRevisionId:null,connectedContext:[],compiledSkills:[],
    harnessPolicyDigest:HASH,toolPolicyDigest:HASH,createdAt:2};
}

function wire() {
  const listeners=new Set<(envelope:WsEnvelope)=>void>();
  const emit=(envelope:WsEnvelope)=>listeners.forEach(listener=>listener(envelope));
  const bus:Bus={emit,emitToSession:(id,payload)=>emit({topic:`session:${id}`,...payload}),
    emitToProject:(id,payload)=>emit({topic:`project:${id}`,...payload}),
    emitToWorkItem:(id,payload)=>emit({topic:`work-item:${id}`,...payload}),
    emitGlobal:payload=>emit({topic:"global",...payload}),
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  return {bus,emit};
}

function child(input:{attemptId:string;attemptNumber:number;taskId:string},ordinal:number):WorkItemRunSnapshot {
  return {runKey:`child-${ordinal}`,workItemId:"work",runKind:"child",parentRunKey:"primary",
    taskId:input.taskId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,runNumber:null,
    previousRunKey:null,providerSessionId:null,outcome:"none",startedAt:10+ordinal,endedAt:null,
    finalReport:null};
}

async function blockedFixture(completionMode:"task"|"verification"="verification",
  downstream=false,withOutput=false,stageOutput=withOutput,
  verificationResult:"passed"|"failed"|"inconclusive"="inconclusive") {
  const db=setup();const transport=wire();let at=20;const launches:WorkItemRunSnapshot[]=[];
  const service=new TaskGraphService({db,bus:transport.bus,now:()=>at++,children:{
    startChildRun:async input=>{const run=child(input,launches.length+1);launches.push(run);return run;},
  }});
  service.start();service.createRevision(revision(completionMode,downstream,withOutput),3);
  await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
    sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
  if (withOutput && stageOutput) service.stageArtifactForSession(launches[0]!.runKey,{source:"inline",
    inlineJson:{result:"reviewed"},outputName:"result",schemaName:"Result",schemaVersion:"1",
    classification:"internal",retentionPolicy:"keep",observedWriteSet:[]});
  transport.emit({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
    run:{...launches[0]!,outcome:completionMode==="verification"?"completed":"error",endedAt:30,
      finalReport:completionMode==="verification"
        ? JSON.stringify({result:verificationResult,confidence:0.2,summary:"missing test output"})
        : "failed"},timestamp:30});
  await vi.waitFor(()=>expect(service.snapshot("run").run.status).toBe("blocked"));
  return {db,service,launches};
}

describe("verification-node adjudication",()=>{
  it("accepts with an audit record without rewriting the failed witness",async()=>{
    const {db,service}=await blockedFixture();
    const before=service.snapshot("run");const attempt=String(before.attempts[0]?.id);
    const input={runId:"run",nodeId:"verify",currentAttemptId:attempt,
      expectedRunRevision:before.run.revision,requestId:"accept-1",decision:"accepted" as const,
      actor:"leader:primary",reason:"The Leader independently confirmed the required checks."};
    const accepted=await service.adjudicateNode(input);

    expect(accepted.run.status).toBe("completed");
    expect(accepted.attempts[0]).toMatchObject({id:attempt,outcome:"failed",
      terminal_witness_json:{completionVerdict:{result:"inconclusive"}}});
    expect(accepted.adjudications).toEqual([expect.objectContaining({attempt_id:attempt,
      decision:"accepted",actor:"leader:primary"})]);
    expect(service.viewSnapshot("run").nodes[0]).toMatchObject({logicalState:"succeeded",
      currentAttempt:{state:"failed"},adjudication:{decision:"accepted",attemptId:attempt}});

    const revision=accepted.run.revision;
    expect((await service.adjudicateNode(input)).run.revision).toBe(revision);
    expect((db.prepare("SELECT count(*) n FROM task_node_adjudications").get() as {n:number}).n).toBe(1);
    await expect(service.adjudicateNode({...input,reason:"different"}))
      .rejects.toBeInstanceOf(TaskGraphConflictError);
    service.dispose();
  });

  it("immediately schedules downstream work after acceptance",async()=>{
    const {service,launches}=await blockedFixture("verification",true);
    const before=service.snapshot("run");
    const accepted=await service.adjudicateNode({runId:"run",nodeId:"verify",
      currentAttemptId:String(before.attempts[0]?.id),expectedRunRevision:before.run.revision,
      requestId:"accept-forward",decision:"accepted",actor:"leader:primary",
      reason:"The Leader independently confirmed the required checks."});

    expect(accepted.run.status).toBe("active");
    expect(launches).toHaveLength(2);
    expect(accepted.attempts).toContainEqual(expect.objectContaining({node_id:"next",
      runtime:"running"}));
    service.dispose();
  });

  it("promotes the accepted attempt's declared outputs without rewriting its failed witness",async()=>{
    const {db,service}=await blockedFixture("verification",false,true);
    const before=service.snapshot("run");
    expect(before.artifacts[0]).toMatchObject({state:"rejected"});

    const accepted=await service.adjudicateNode({runId:"run",nodeId:"verify",
      currentAttemptId:String(before.attempts[0]?.id),expectedRunRevision:before.run.revision,
      requestId:"accept-output",decision:"accepted",actor:"leader:primary",
      reason:"The Leader independently confirmed the output and verification evidence."});

    expect(accepted.run.status).toBe("completed");
    expect(accepted.attempts[0]).toMatchObject({outcome:"failed"});
    expect(accepted.artifacts[0]).toMatchObject({state:"committed",committed_at:expect.any(Number)});
    expect(service.viewSnapshot("run").nodes[0]).toMatchObject({logicalState:"succeeded",
      outputArtifactIds:[expect.any(String)]});
    expect((db.prepare("SELECT state FROM task_artifacts").get() as {state:string}).state)
      .toBe("committed");
    service.dispose();
  });

  it("authorizes accepted outputs for an artifact-dependent successor",async()=>{
    const {service,launches}=await blockedFixture("verification",true,true);
    const before=service.snapshot("run");

    await service.adjudicateNode({runId:"run",nodeId:"verify",
      currentAttemptId:String(before.attempts[0]?.id),expectedRunRevision:before.run.revision,
      requestId:"accept-artifact-edge",decision:"accepted",actor:"leader:primary",
      reason:"The Leader independently confirmed the output and verification evidence."});

    expect(launches).toHaveLength(2);
    expect(taskGraphArtifactsForSession(service,launches[1]!.runKey)).toEqual([
      expect.objectContaining({outputName:"result",inputName:"result"}),
    ]);
    service.dispose();
  });

  it("records rejection as terminal graph failure",async()=>{
    const {service}=await blockedFixture();const before=service.snapshot("run");
    const rejected=await service.adjudicateNode({runId:"run",nodeId:"verify",
      currentAttemptId:String(before.attempts[0]?.id),expectedRunRevision:before.run.revision,
      requestId:"reject-1",decision:"rejected",actor:"leader:primary",
      reason:"The supplied evidence does not meet the acceptance criteria."});
    expect(rejected.run.status).toBe("failed");
    expect(rejected.adjudications[0]).toMatchObject({decision:"rejected"});
    service.dispose();
  });

  it("retries with durable guidance and a fresh attempt",async()=>{
    const {service,launches}=await blockedFixture();const before=service.snapshot("run");
    const prior=String(before.attempts[0]?.id);
    const retried=await service.adjudicateNode({runId:"run",nodeId:"verify",currentAttemptId:prior,
      expectedRunRevision:before.run.revision,requestId:"retry-1",decision:"retry",
      actor:"leader:primary",reason:"The report omitted command output.",
      guidance:"Run the focused suite and include its exact exit status."});

    expect(retried.run.status).toBe("active");
    expect(retried.attempts).toHaveLength(2);expect(launches).toHaveLength(2);
    expect(retried.invalidations).toEqual([expect.objectContaining({invalidated_attempt_id:prior})]);
    expect(retried.steeringEvents[0]).toMatchObject({record_json:expect.objectContaining({
      instructions:"Run the focused suite and include its exact exit status."})});
    expect(retried.adjudications[0]).toMatchObject({decision:"retry",guidance:
      "Run the focused suite and include its exact exit status."});
    service.dispose();
  });

  it("keeps a passed report with missing declared outputs retryable or rejectable",async()=>{
    const {service,launches}=await blockedFixture("verification",false,true,false,"passed");
    const before=service.snapshot("run");
    const attempt=String(before.attempts[0]?.id);
    expect(before.attempts[0]).toMatchObject({outcome:"failed",
      terminal_witness_json:{completionVerdict:{result:"passed"}}});

    await expect(service.adjudicateNode({runId:"run",nodeId:"verify",
      currentAttemptId:attempt,expectedRunRevision:before.run.revision,
      requestId:"accept-incomplete",decision:"accepted",actor:"leader:primary",
      reason:"The report passed."})).rejects.toBeInstanceOf(TaskGraphValidationError);

    const retried=await service.adjudicateNode({runId:"run",nodeId:"verify",
      currentAttemptId:attempt,expectedRunRevision:before.run.revision,
      requestId:"retry-incomplete",decision:"retry",actor:"leader:primary",
      reason:"The declared output is missing.",guidance:"Produce the declared result output."});
    expect(retried.run.status).toBe("active");
    expect(launches).toHaveLength(2);
    expect(retried.invalidations).toContainEqual(expect.objectContaining({
      invalidated_attempt_id:attempt,
    }));
    service.dispose();
  });

  it("rejects stale fences, non-verification nodes, and request-id drift",async()=>{
    const first=await blockedFixture();const snapshot=first.service.snapshot("run");
    const attempt=String(snapshot.attempts[0]?.id);
    await expect(first.service.adjudicateNode({runId:"run",nodeId:"verify",currentAttemptId:attempt,
      expectedRunRevision:snapshot.run.revision-1,requestId:"stale",decision:"accepted",
      actor:"leader",reason:"reviewed"})).rejects.toBeInstanceOf(TaskGraphConflictError);
    first.service.dispose();

    const second=await blockedFixture("task");const task=second.service.snapshot("run");
    await expect(second.service.adjudicateNode({runId:"run",nodeId:"verify",
      currentAttemptId:String(task.attempts[0]?.id),expectedRunRevision:task.run.revision,
      requestId:"ordinary",decision:"accepted",actor:"leader",reason:"reviewed"}))
      .rejects.toBeInstanceOf(TaskGraphValidationError);
    second.service.dispose();
  });
});
