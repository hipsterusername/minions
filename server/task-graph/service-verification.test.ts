import "./test-helpers.ts";
import {describe,expect,it,vi} from "vitest";
import type {Bus} from "../bus.ts";
import type {WsEnvelope} from "../../shared/ws-envelope.ts";
import type {GraphRevisionInput,SourceSnapshot} from "../../shared/task-graph-contracts.ts";
import type {WorkItemRunSnapshot} from "../../shared/work-item-contracts.ts";
import {initDb} from "../db.ts";
import {ensureWorkItemSchema} from "../work-item-schema.ts";
import {createWorkItem,startWorkItemIteration} from "../work-item-repo.ts";
import {createChildWorkItemRun,sealChildWorkItemRun} from "../work-item-child-repo.ts";
import {TaskGraphConflictError} from "./errors.ts";
import {TaskGraphService} from "./service.ts";

const HASH=`sha256:${"a".repeat(64)}`;

function revision():GraphRevisionInput {
  return {definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",
    objective:"Verify",acceptanceCriteria:["verified"],nonGoals:[],constraints:[],terminalNodeIds:["node"],
    maxActiveAttempts:2,edges:[],nodes:[{id:"node",title:"Node",objective:"Produce",inputBindings:{},
      outputSchemas:{result:{type:"object"}},constraints:[],acceptanceCriteria:["valid"],
      executorClass:"standard",allowedHarnesses:["codex"],allowedTools:[],ownershipRequest:[],budgetRequest:{},
      timeoutMs:30_000,retryPolicy:{maxAttempts:1,backoffMs:0,retryableOutcomes:["failed"],jitterMs:0},
      verificationRequired:true,failurePolicy:"fail_graph",expansionPolicy:null}]};
}

function source():SourceSnapshot {
  return {id:"source",workItemId:"work",primaryRunKey:"primary",taskGraphRevisionId:"revision",
    repositoryBaseCommit:"abc",dirtyDiffDigest:HASH,workspaceId:"workspace",worktreeIdentity:"wt",
    systemModelDigest:HASH,workPacketRevisionId:null,connectedContext:[],compiledSkills:[],
    harnessPolicyDigest:HASH,toolPolicyDigest:HASH,createdAt:2};
}

function fakeBus() {
  const emitted:WsEnvelope[]=[];
  const fan=(envelope:WsEnvelope)=>{emitted.push(envelope);};
  const bus:Bus={emit:fan,emitToSession:(id,payload)=>fan({topic:`session:${id}`,...payload}),
    emitToProject:(id,payload)=>fan({topic:`project:${id}`,...payload}),
    emitToWorkItem:(id,payload)=>fan({topic:`work-item:${id}`,...payload}),
    emitGlobal:payload=>fan({topic:"global",...payload}),subscribe:()=>()=>{}};
  return {bus,emitted};
}

function child(attemptId:string,attemptNumber:number,runKey="verifier-child"):WorkItemRunSnapshot {
  return {runKey,workItemId:"work",runKind:"child",parentRunKey:"primary",taskId:"node:verification",
    attemptId,attemptNumber,runNumber:null,previousRunKey:null,providerSessionId:null,outcome:"none",
    startedAt:10,endedAt:null,finalReport:null};
}

function fixture(children:ConstructorParameters<typeof TaskGraphService>[0]["children"],now:()=>number) {
  const db=initDb(":memory:");ensureWorkItemSchema(db);const transport=fakeBus();
  createWorkItem(db,{id:"work",projectId:"project",projectPath:process.cwd(),title:"Work",changeMode:"live",at:1});
  startWorkItemIteration(db,{workItemId:"work",runKey:"primary",idempotencyKey:"primary",
    expectedLifecycleRevision:0,expectedCurrentRunKey:null,at:2});
  const service=new TaskGraphService({db,bus:transport.bus,children,now,pollIntervalMs:0});
  service.createRevision(revision(),3);
  service.repo.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
    sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
  db.prepare(`INSERT INTO task_node_attempts
    (id,run_id,node_id,attempt_number,generation,source_snapshot_id,runtime,outcome,
      session_run_key,progress_seq,created_at,updated_at)
    VALUES('producer','graph','node',1,1,'source','terminal','succeeded','producer-child',0,5,6)`).run();
  db.prepare(`INSERT INTO task_artifacts
    (id,run_id,node_id,producer_attempt_id,source_snapshot_id,output_name,content_hash,
      metadata_json,state,created_at,committed_at)
    VALUES('artifact','graph','node','producer','source','result',?,?,'committed',5,6)`)
    .run(HASH,JSON.stringify({schemaName:"Result",schemaVersion:"1",classification:"internal",byteSize:1}));
  return {db,service,...transport};
}

function changed(envelopes:WsEnvelope[]) {
  return envelopes.filter(envelope=>envelope.type==="task_graph_changed") as Array<WsEnvelope&{
    revision:number;cause:string;changes:{nodes:Array<{id:string;verification:{state:string}}>}}>;
}

describe("verification request revision projection",()=>{
  it("rejects stale producer identities before retry, request, or waiver side effects",async()=>{
    const {service,db,emitted}=fixture({startChildRun:async input=>
      child(input.attemptId,input.attemptNumber)},()=>10);
    const beforeVerification=service.snapshot("graph");

    await expect(service.requestVerification({runId:"graph",nodeId:"node",
      currentAttemptId:"superseded",expectedRunRevision:0,requestId:"stale-request"}))
      .rejects.toBeInstanceOf(TaskGraphConflictError);
    await expect(service.waiveVerification({runId:"graph",nodeId:"node",
      currentAttemptId:"superseded",expectedRunRevision:0,actor:"operator",reason:"reviewed",
      requestId:"stale-waiver"}))
      .rejects.toBeInstanceOf(TaskGraphConflictError);
    expect(service.snapshot("graph")).toEqual(beforeVerification);
    expect(emitted).toEqual([]);
    expect((db.prepare("SELECT count(*) count FROM task_verification_requests").get() as {count:number}).count)
      .toBe(0);
    expect((db.prepare("SELECT count(*) count FROM task_verifications").get() as {count:number}).count)
      .toBe(0);
    expect((db.prepare("SELECT count(*) count FROM work_item_commands").get() as {count:number}).count)
      .toBe(0);

    db.prepare("UPDATE task_node_attempts SET outcome='failed' WHERE id='producer'").run();
    const beforeRetry=service.snapshot("graph");
    await expect(service.retryNode({runId:"graph",nodeId:"node",currentAttemptId:"superseded",
      expectedRunRevision:0,requestId:"stale-retry"})).rejects.toBeInstanceOf(TaskGraphConflictError);
    expect(service.snapshot("graph")).toEqual(beforeRetry);
    expect(emitted).toEqual([]);
    expect((db.prepare("SELECT count(*) count FROM task_manual_retry_grants").get() as {count:number}).count)
      .toBe(0);
    expect((db.prepare("SELECT count(*) count FROM work_item_commands").get() as {count:number}).count)
      .toBe(0);
    service.dispose();
  });

  it("emits one adjacent affected-node revision for request, claim, and acknowledgement",async()=>{
    const {service,db,emitted}=fixture({startChildRun:async input=>
      child(input.attemptId,input.attemptNumber)},()=>10);

    await service.requestVerification({runId:"graph",nodeId:"node",currentAttemptId:"producer",
      expectedRunRevision:0,requestId:"request-command"});

    expect(service.snapshot("graph").run.revision).toBe(3);
    expect(db.prepare(`SELECT run_revision,type,object_id FROM task_scheduler_events
      WHERE run_revision>0 ORDER BY sequence`).all()).toEqual([
      {run_revision:1,type:"verification_requested",object_id:expect.any(String)},
      {run_revision:2,type:"verification_launch_claimed",object_id:expect.any(String)},
      {run_revision:3,type:"verification_launch_acknowledged",object_id:expect.any(String)},
    ]);
    expect(changed(emitted).map(event=>[event.revision,event.cause,event.changes.nodes.map(node=>node.id)]))
      .toEqual([[1,"verification_requested",["node"]],[2,"verification_launch_claimed",["node"]],
        [3,"verification_launch_acknowledged",["node"]]]);

    const eventCount=Number((db.prepare("SELECT count(*) n FROM task_scheduler_events").get() as {n:number}).n);
    await service.requestVerification({runId:"graph",nodeId:"node",currentAttemptId:"producer",
      expectedRunRevision:0,requestId:"request-command"});
    expect(service.snapshot("graph").run.revision).toBe(3);
    expect((db.prepare("SELECT count(*) n FROM task_scheduler_events").get() as {n:number}).n).toBe(eventCount);
    service.dispose();
  });

  it("projects delayed retry and durable restart rebind as adjacent revisions",async()=>{
    let at=10;let launches=0;
    const delayed=fixture({startChildRun:async input=>{
      launches+=1;if (launches===1) throw new Error("temporarily unavailable");
      return child(input.attemptId,input.attemptNumber,"retried-verifier");
    }},()=>at);
    await delayed.service.requestVerification({runId:"graph",nodeId:"node",currentAttemptId:"producer",
      expectedRunRevision:0});
    expect(delayed.service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"pending",launch_attempts:1,next_retry_at:1_010});
    at=1_010;await delayed.service.tick("graph");
    expect(delayed.service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"running",verifier_run_key:"retried-verifier"});
    const transitionRevisions=changed(delayed.emitted)
      .filter(event=>event.cause.startsWith("verification_"))
      .map(event=>event.revision);
    expect(transitionRevisions).toEqual([1,2,3,4,5]);
    delayed.service.dispose();

    const rebound=fixture({startChildRun:async input=>child(input.attemptId,input.attemptNumber)},()=>60_001);
    rebound.db.prepare(`INSERT INTO task_verification_requests
      (id,run_id,node_id,producer_attempt_id,verifier_attempt_id,status,created_at,updated_at)
      VALUES('rebind','graph','node','producer','verifier-rebind','launching',7,7)`).run();
    createChildWorkItemRun(rebound.db,{workItemId:"work",runKey:"allocated-verifier",parentRunKey:"primary",
      taskId:"node:verification",attemptId:"verifier-rebind",attemptNumber:1,
      idempotencyKey:"task-graph-verifier:verifier-rebind",at:20});
    await rebound.service.tick("graph");
    expect(rebound.service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"running",verifier_run_key:"allocated-verifier"});
    expect(changed(rebound.emitted)).toContainEqual(expect.objectContaining({revision:1,
      cause:"verification_launch_rebound",changes:expect.objectContaining({nodes:[expect.objectContaining({id:"node"})]})}));
    rebound.service.dispose();
  });

  it("cancels an unacknowledged late verifier without accepting a duplicate session",async()=>{
    let release!:(value:WorkItemRunSnapshot)=>void;
    const gate=new Promise<WorkItemRunSnapshot>(resolve=>{release=resolve;});const cancelled:string[]=[];
    const {service}=fixture({startChildRun:async()=>gate,
      cancelChildRun:async runKey=>{cancelled.push(runKey);}},()=>10);
    const launching=service.requestVerification({runId:"graph",nodeId:"node",currentAttemptId:"producer",
      expectedRunRevision:0});
    await vi.waitFor(()=>expect(service.snapshot("graph").verificationRequests[0]).toMatchObject({status:"launching"}));
    await service.cancel("graph",service.snapshot("graph").run.revision);
    release(child("verifier-late",1,"late-verifier"));
    await launching;

    expect(cancelled).toEqual(["late-verifier"]);
    expect(service.snapshot("graph").run.revision).toBe(3);
    expect(service.snapshot("graph").events.some(event=>event.type==="verification_launch_acknowledged")).toBe(false);
    expect(service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"failed",verifier_run_key:null,result:"graph cancelled"});
    service.dispose();
  });

  it("records a normal verdict on only the existing evidence revision",async()=>{
    let db!:ReturnType<typeof initDb>;
    const ready=fixture({startChildRun:async input=>{
      createChildWorkItemRun(db,{workItemId:"work",runKey:"verifier-verdict",parentRunKey:"primary",
        taskId:input.taskId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,
        idempotencyKey:input.requestId,at:10});
      return child(input.attemptId,input.attemptNumber,"verifier-verdict");
    }},()=>20);
    db=ready.db;
    await ready.service.requestVerification({runId:"graph",nodeId:"node",currentAttemptId:"producer",
      expectedRunRevision:0});
    const before=ready.service.snapshot("graph").run.revision;
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"verifier-verdict",outcome:"completed",
      finalReport:JSON.stringify({result:"passed",confidence:0.9}),at:21});
    await ready.service.tick("graph");

    const snapshot=ready.service.snapshot("graph");
    expect(snapshot.run.revision).toBe(before+1);
    expect(snapshot.events.filter(event=>event.type==="verification_recorded")).toHaveLength(1);
    expect(snapshot.verificationRequests[0]).toMatchObject({status:"completed",result:"passed"});
    ready.service.dispose();
  });

  it("applies node failure policy when an independent verifier rejects the output",async()=>{
    let db!:ReturnType<typeof initDb>;
    const rejected=fixture({startChildRun:async input=>{
      createChildWorkItemRun(db,{workItemId:"work",runKey:"verifier-rejected",parentRunKey:"primary",
        taskId:input.taskId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,
        idempotencyKey:input.requestId,at:10});
      return child(input.attemptId,input.attemptNumber,"verifier-rejected");
    }},()=>20);
    db=rejected.db;
    await rejected.service.requestVerification({runId:"graph",nodeId:"node",
      currentAttemptId:"producer",expectedRunRevision:0});
    const rejectionSummary=`Hash mismatch at output.result ${"x".repeat(1_200)}`;
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"verifier-rejected",outcome:"completed",
      finalReport:JSON.stringify({result:"failed",confidence:0.95,summary:rejectionSummary}),at:21});
    await rejected.service.tick("graph");

    const snapshot=rejected.service.snapshot("graph");
    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.verificationRequests[0]).toMatchObject({status:"completed",result:"failed"});
    expect(snapshot.events).toContainEqual(expect.objectContaining({type:"verification_disposition",
      payload:expect.objectContaining({nodeId:"node",result:"failed",status:"failed"})}));
    const durable=snapshot.verifications[0]!["record_json"] as {summary:string};
    expect(durable.summary).toHaveLength(1_000);
    expect(durable.summary).toContain("Hash mismatch at output.result");
    expect(rejected.service.viewSnapshot("graph").nodes[0]).toMatchObject({
      verification:{state:"failed",explanation:expect.stringContaining("Hash mismatch at output.result")},
      blocker:{category:"policy",explanation:expect.stringContaining("Hash mismatch at output.result")},
    });
    rejected.service.dispose();
  });

  it("lets the Leader resolve a rejected producer verification without rewriting evidence",async()=>{
    let db!:ReturnType<typeof initDb>;
    const rejected=fixture({startChildRun:async input=>{
      createChildWorkItemRun(db,{workItemId:"work",runKey:"verifier-adjudicated",
        parentRunKey:"primary",taskId:input.taskId,attemptId:input.attemptId,
        attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at:10});
      return child(input.attemptId,input.attemptNumber,"verifier-adjudicated");
    }},()=>20);
    db=rejected.db;
    await rejected.service.requestVerification({runId:"graph",nodeId:"node",
      currentAttemptId:"producer",expectedRunRevision:0});
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"verifier-adjudicated",outcome:"completed",
      finalReport:JSON.stringify({result:"failed",confidence:0.95,
        summary:"The output needs a documented exception."}),at:21});
    await rejected.service.tick("graph");
    const blocked=rejected.service.snapshot("graph");
    expect(blocked.run.status).toBe("failed");

    const accepted=await rejected.service.adjudicateNode({runId:"graph",nodeId:"node",
      currentAttemptId:"producer",expectedRunRevision:blocked.run.revision,
      requestId:"accept-rejected-verification",decision:"accepted",
      actor:"leader:primary",reason:"The Leader reviewed and accepted the documented exception."});

    expect(accepted.run.status).toBe("completed");
    expect(accepted.verifications[0]).toMatchObject({result:"failed"});
    expect(accepted.adjudications[0]).toMatchObject({decision:"accepted",
      attempt_id:"producer"});
    expect(rejected.service.viewSnapshot("graph").nodes[0]).toMatchObject({
      logicalState:"succeeded",verification:{state:"failed"},
      adjudication:{decision:"accepted"},
    });
    rejected.service.dispose();
  });

  it("retries one inconclusive verifier and then applies failure policy",async()=>{
    let db!:ReturnType<typeof initDb>;let launches=0;
    const inconclusive=fixture({startChildRun:async input=>{
      launches+=1;const runKey=`verifier-inconclusive-${launches}`;
      createChildWorkItemRun(db,{workItemId:"work",runKey,parentRunKey:"primary",taskId:input.taskId,
        attemptId:input.attemptId,attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at:10+launches});
      return child(input.attemptId,input.attemptNumber,runKey);
    }},()=>30);
    db=inconclusive.db;
    await inconclusive.service.requestVerification({runId:"graph",nodeId:"node",
      currentAttemptId:"producer",expectedRunRevision:0});
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"verifier-inconclusive-1",outcome:"completed",
      finalReport:null,at:21});
    await inconclusive.service.tick("graph");

    expect(launches).toBe(2);
    expect(inconclusive.service.snapshot("graph").verificationRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({status:"completed",result:"inconclusive"}),
      expect.objectContaining({status:"running",verifier_run_key:"verifier-inconclusive-2"}),
    ]));
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"verifier-inconclusive-2",outcome:"completed",
      finalReport:null,at:22});
    await inconclusive.service.tick("graph");

    const snapshot=inconclusive.service.snapshot("graph");
    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.verificationRequests.filter(request=>request.result==="inconclusive")).toHaveLength(2);
    inconclusive.service.dispose();
  });

  it("recovers a graph stranded by exhausted verifier records from an older runtime",async()=>{
    const {service,db}=fixture({startChildRun:async input=>
      child(input.attemptId,input.attemptNumber)},()=>40);
    for (const ordinal of [1,2]) {
      const requestId=`legacy-request-${ordinal}`;const verifierId=`legacy-verifier-${ordinal}`;
      db.prepare(`INSERT INTO task_verification_requests
        (id,run_id,node_id,producer_attempt_id,verifier_attempt_id,status,result,created_at,updated_at)
        VALUES(?,'graph','node','producer',?,'completed','inconclusive',?,?)`)
        .run(requestId,verifierId,10+ordinal,10+ordinal);
      const record={runId:"graph",nodeId:"node",producerAttemptId:"producer",
        verifierAttemptId:verifierId,result:"inconclusive"};
      db.prepare(`INSERT INTO task_verifications
        (id,run_id,node_id,producer_attempt_id,verifier_attempt_id,source_snapshot_id,
          fingerprint,result,record_json,created_at,completed_at)
        VALUES(?,'graph','node','producer',?,'source',?,'inconclusive',?,?,?)`)
        .run(`legacy-verification-${ordinal}`,verifierId,HASH,JSON.stringify(record),
          10+ordinal,10+ordinal);
    }
    db.prepare("UPDATE task_graph_runs SET status='blocked' WHERE id='graph'").run();

    await service.tick("graph");
    const snapshot=service.snapshot("graph");
    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.events.filter(event=>event.type==="verification_disposition")).toHaveLength(1);
    await service.tick("graph");
    expect(service.snapshot("graph").events
      .filter(event=>event.type==="verification_disposition")).toHaveLength(1);
    service.dispose();
  });
});
