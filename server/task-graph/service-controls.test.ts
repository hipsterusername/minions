import "./test-helpers.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import { describe,expect,it,vi } from "vitest";
import type { Bus } from "../bus.ts";
import { initDb } from "../db.ts";
import { createWorkItem,startWorkItemIteration } from "../work-item-repo.ts";
import { createChildWorkItemRun } from "../work-item-child-repo.ts";
import { ensureWorkItemSchema } from "../work-item-schema.ts";
import type { GraphRevisionInput,SourceSnapshot } from "../../shared/task-graph-contracts.ts";
import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import type { WsEnvelope } from "../../shared/ws-envelope.ts";
import { TaskGraphConflictError } from "./errors.ts";
import { TaskGraphService } from "./service.ts";

const HASH=`sha256:${"a".repeat(64)}`;
const PACKAGE_BYTES=fs.readFileSync("package.json");
const PACKAGE_HASH=`sha256:${crypto.createHash("sha256").update(PACKAGE_BYTES).digest("hex")}`;

function setup() {
  const db=initDb(":memory:");ensureWorkItemSchema(db);
  createWorkItem(db,{id:"work",projectId:"project",projectPath:process.cwd(),title:"Work",
    changeMode:"live",at:1});
  startWorkItemIteration(db,{workItemId:"work",runKey:"primary",idempotencyKey:"primary",
    expectedLifecycleRevision:0,expectedCurrentRunKey:null,at:2});
  return db;
}

function graph(withArtifact=false):GraphRevisionInput {
  const base={title:"A",objective:"Do A",inputBindings:{},constraints:[],acceptanceCriteria:[],
    executorClass:"standard" as const,allowedHarnesses:["codex"],allowedTools:[],ownershipRequest:[],
    budgetRequest:{},timeoutMs:30_000,retryPolicy:{maxAttempts:2,backoffMs:0,
      retryableOutcomes:["failed" as const,"lost" as const],jitterMs:0},verificationRequired:false,
    failurePolicy:"fail_graph" as const,expansionPolicy:null};
  return {definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",
    objective:"Mission",acceptanceCriteria:["done"],nonGoals:[],constraints:[],terminalNodeIds:["b"],
    maxActiveAttempts:2,nodes:[{id:"a",...base,outputSchemas:withArtifact?{result:{type:"object"}}:{}},
      {id:"b",...base,title:"B",objective:"Do B",outputSchemas:{}}],edges:[{
        id:"a-b",sourceNodeId:"a",targetNodeId:"b",kind:"control",sourceOutput:null,targetInput:null,
        satisfactionPolicy:"all_success",failurePolicy:"fail",optional:false,
      }]};
}

function source():SourceSnapshot {
  return {id:"source",workItemId:"work",primaryRunKey:"primary",taskGraphRevisionId:"revision",
    repositoryBaseCommit:"abc",dirtyDiffDigest:HASH,workspaceId:"workspace",worktreeIdentity:"worktree",
    systemModelDigest:HASH,workPacketRevisionId:null,connectedContext:[],compiledSkills:[],
    harnessPolicyDigest:HASH,toolPolicyDigest:HASH,createdAt:2};
}

function transport() {
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

describe("TaskGraphService controls",()=>{
  it("projects retry backoff as quiescent without conflating it with an operator pause",async()=>{
    const db=setup();const wire=transport();let at=10;const launches:WorkItemRunSnapshot[]=[];
    const service=new TaskGraphService({db,bus:wire.bus,now:()=>at,children:{startChildRun:async input=>{
      const run=child(input,launches.length+1);launches.push(run);return run;
    }}});
    const spec=graph();spec.nodes[0]={...spec.nodes[0]!,retryPolicy:{
      ...spec.nodes[0]!.retryPolicy,backoffMs:100,
    }};
    service.start();service.createRevision(spec,3);
    await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    wire.emit({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{...launches[0]!,outcome:"error",endedAt:20,finalReport:"retry"},timestamp:20});
    await vi.waitFor(()=>expect(service.snapshot("run").run.status).toBe("quiescent"));
    expect(service.viewSnapshot("run")).toMatchObject({status:"quiescent",nodes:[
      expect.objectContaining({blocker:expect.objectContaining({category:"backoff"})}),
      expect.any(Object),
    ]});

    at=121;await service.tick("run");
    expect(launches).toHaveLength(2);
    expect(service.snapshot("run").run.status).toBe("active");
    service.dispose();
  });

  it("projects provider-reported attempt usage instead of budget reservations",async()=>{
    const db=setup();const {bus}=transport();
    const service=new TaskGraphService({db,bus,children:{startChildRun:async input=>{
      createChildWorkItemRun(db,{workItemId:"work",runKey:"usage-child",parentRunKey:"primary",
        taskId:input.taskId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,
        idempotencyKey:input.requestId,at:5});
      return {...child(input,1),runKey:"usage-child"};
    }}});
    service.createRevision(graph(),3);
    await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    db.prepare("UPDATE sessions SET total_cost=? WHERE session_key=?").run(0.25,"usage-child");
    db.prepare(`INSERT INTO session_usage (session_key,role,model,source,input_tokens,output_tokens,
      cache_read_tokens,cache_creation_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run("usage-child","minion","model","assistant",120,30,0,0,null,6);

    const view=service.viewSnapshot("run");
    expect(view.nodes[0]).toMatchObject({costUsd:0.25,tokens:150,
      currentAttempt:expect.objectContaining({costUsd:0.25,tokens:150})});
    expect(view.budget).toMatchObject({spentUsd:0.25,tokens:150});
  });

  it("replays an identical mutation request without advancing canonical state",async()=>{
    const db=setup();const {bus}=transport();
    const service=new TaskGraphService({db,bus,children:{startChildRun:async input=>child(input,1)}});
    service.createRevision(graph(),3);
    await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const before=service.snapshot("run").run.revision;
    const first=await service.pause("run",before,true,"pause-request");
    const replay=await service.pause("run",before,true,"pause-request");

    expect(replay.run.revision).toBe(first.run.revision);
    await expect(service.pause("run",first.run.revision,false,"pause-request"))
      .rejects.toBeInstanceOf(TaskGraphConflictError);
  });

  it.each(["completed","failed","cancelled"] as const)(
    "rejects every control for a %s run without canonical side effects",async status=>{
      const db=setup();const {bus}=transport();
      const service=new TaskGraphService({db,bus,children:{startChildRun:async input=>child(input,1)}});
      service.createRevision(graph(),3);
      await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
        sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});

      for (const control of ["pause","resume","cancel"] as const) {
        db.prepare("UPDATE task_graph_runs SET status=?,paused=? WHERE id=?")
          .run(status,control==="resume"?1:0,"run");
        const before=service.snapshot("run");
        const invoke=control==="cancel"
          ? service.cancel("run",before.run.revision)
          : service.pause("run",before.run.revision,control==="pause");

        await expect(invoke).rejects.toBeInstanceOf(TaskGraphConflictError);
        expect(service.snapshot("run")).toEqual(before);
      }
    });

  it.each(["active","quiescent","blocked"] as const)(
    "preserves legal pause, resume, and cancel transitions for a %s run",async status=>{
      const db=setup();const {bus}=transport();
      const service=new TaskGraphService({db,bus,children:{startChildRun:async input=>child(input,1)}});
      service.createRevision(graph(),3);
      await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
        sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
      db.prepare("UPDATE task_graph_runs SET status=? WHERE id=?").run(status,"run");

      const initial=service.snapshot("run");
      const paused=service.scheduler.pause("run",initial.run.revision,true,5);
      expect(service.snapshot("run").run).toMatchObject({status,paused:true,revision:paused});
      const resumed=service.scheduler.pause("run",paused,false,6);
      expect(service.snapshot("run").run).toMatchObject({status,paused:false,revision:resumed});
      const cancelled=service.scheduler.cancelRun("run",resumed,7);
      expect(service.snapshot("run").run).toMatchObject({status:"cancelled",paused:true,
        revision:cancelled});
    });

  it.each(["active","quiescent","blocked"] as const)(
    "rejects resume for an unpaused %s run without canonical side effects",async status=>{
      const db=setup();const {bus}=transport();
      const service=new TaskGraphService({db,bus,children:{startChildRun:async input=>child(input,1)}});
      service.createRevision(graph(),3);
      await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
        sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
      db.prepare("UPDATE task_graph_runs SET status=?,paused=0 WHERE id=?").run(status,"run");
      const before=service.snapshot("run");

      await expect(service.pause("run",before.run.revision,false))
        .rejects.toBeInstanceOf(TaskGraphConflictError);
      expect(service.snapshot("run")).toEqual(before);
    });

  it.each(["active","quiescent","blocked"] as const)(
    "rejects pause for an already paused %s run without canonical side effects",async status=>{
      const db=setup();const {bus}=transport();
      const service=new TaskGraphService({db,bus,children:{startChildRun:async input=>child(input,1)}});
      service.createRevision(graph(),3);
      await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
        sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
      db.prepare("UPDATE task_graph_runs SET status=?,paused=1 WHERE id=?").run(status,"run");
      const before=service.snapshot("run");

      await expect(service.pause("run",before.run.revision,true))
        .rejects.toBeInstanceOf(TaskGraphConflictError);
      expect(service.snapshot("run")).toEqual(before);
    });

  it("reopens terminal edges before admitting an operator-granted retry",async()=>{
    const db=setup();const wire=transport();let dispatchEnabled=true;
    const launches:WorkItemRunSnapshot[]=[];
    const service=new TaskGraphService({db,bus:wire.bus,availableDispatchSlots:()=>dispatchEnabled?2:0,
      children:{startChildRun:async input=>{
        const run=child(input,launches.length+1);launches.push(run);return run;
      }}});
    const spec=graph();
    spec.nodes[0]={...spec.nodes[0]!,failurePolicy:"satisfy_all_terminal_only",retryPolicy:{
      ...spec.nodes[0]!.retryPolicy,maxAttempts:1,
    }};
    spec.edges[0]={...spec.edges[0]!,satisfactionPolicy:"all_terminal"};
    service.start();service.createRevision(spec,3);
    await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    dispatchEnabled=false;
    wire.emit({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{...launches[0]!,outcome:"error",endedAt:20,finalReport:"retry manually"},timestamp:20});
    await vi.waitFor(()=>expect(service.snapshot("run").edgeEvaluations[0])
      .toMatchObject({satisfied:1,reason:"satisfied"}));
    db.prepare("UPDATE task_graph_runs SET status='failed' WHERE id='run'").run();
    const settled=service.snapshot("run");const first=settled.attempts[0]!;

    dispatchEnabled=true;
    const retryInput={runId:"run",nodeId:"a",expectedRunRevision:settled.run.revision,
      currentAttemptId:String(first["id"]),requestId:"retry-a"};
    const retried=await service.retryNode(retryInput);

    expect(launches).toHaveLength(2);
    expect(launches[1]).toMatchObject({taskId:"a",attemptNumber:2});
    expect(retried.run.status).toBe("active");
    expect(retried.edgeEvaluations[0]).toMatchObject({satisfied:0,reason:"upstream_not_satisfied"});
    expect(retried.attempts).toHaveLength(2);
    const replayed=await service.retryNode(retryInput);
    expect(replayed.run.revision).toBe(retried.run.revision);
    expect(launches).toHaveLength(2);
    service.dispose();
  });

  it("durably invalidates an impacted subtree, cancels stale work, and launches a steered attempt",async()=>{
    const db=setup();const {bus}=transport();const launches:Array<Record<string,unknown>>=[];
    const cancelled:string[]=[];
    const service=new TaskGraphService({db,bus,now:(()=>{let at=10;return()=>at++;})(),children:{
      startChildRun:async input=>{launches.push(input);return child(input,launches.length);},
      cancelChildRun:async runKey=>{cancelled.push(runKey);},
    }});
    service.createRevision(graph(),3);
    await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const first=service.snapshot("run").attempts[0]!;

    await service.steer({runId:"run",expectedRunRevision:2,requestId:"steer-1",
      instructions:"Use the revised acceptance wording",affectedNodeIds:["a"]});

    const snapshot=service.snapshot("run");
    expect(cancelled).toEqual(["child-1"]);
    expect(snapshot.invalidations).toEqual([
      expect.objectContaining({node_id:"a",invalidated_attempt_id:first["id"]}),
      expect.objectContaining({node_id:"b",invalidated_attempt_id:null}),
    ]);
    expect(snapshot.attempts).toHaveLength(2);
    expect(snapshot.attempts[0]).toMatchObject({id:first["id"],runtime:"terminal",outcome:"superseded"});
    expect(String(launches[1]!["prompt"])).toContain("Use the revised acceptance wording");
    expect(service.viewSnapshot("run").evidence).toEqual([]);
  });

  it("returns safe artifact metadata and fingerprints exact reconciliation inputs",async()=>{
    const db=setup();const wire=transport();let launched:WorkItemRunSnapshot|null=null;let launchCount=0;
    const service=new TaskGraphService({db,bus:wire.bus,children:{startChildRun:async input=>{
      launchCount+=1;launched=child(input,launchCount);return launched;
    }}});
    service.start();service.createRevision(graph(true),3);
    await service.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    service.stageArtifactForSession("child-1",{schemaName:"Result",schemaVersion:"1",
      contentHash:PACKAGE_HASH,storageRef:"package.json",byteSize:PACKAGE_BYTES.length,
      classification:"internal",retentionPolicy:"keep",outputName:"result",observedWriteSet:[]});
    wire.emit({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{...launched!,outcome:"completed",endedAt:20,finalReport:"done"},timestamp:20});
    await vi.waitFor(()=>expect(service.snapshot("run").artifacts[0]).toMatchObject({state:"committed"}));
    await service.tick("run");
    const current=service.snapshot("run");const artifactId=String(current.artifacts[0]!["id"]);

    const artifact=service.artifact({runId:"run",artifactId});
    expect(artifact).toMatchObject({id:artifactId,contentHash:PACKAGE_HASH,byteSize:PACKAGE_BYTES.length});
    expect(artifact).not.toHaveProperty("storageRef");
    const reconciliationRevision=current.run.revision;
    const reconciled=await service.reconcile({runId:"run",expectedRunRevision:reconciliationRevision,
      requestId:"reconcile-1",artifactIds:[artifactId],verificationIds:[],sourceDiffHash:HASH});
    expect(reconciled.reconciliations).toHaveLength(1);
    await expect(service.reconcile({runId:"run",expectedRunRevision:reconciliationRevision,
      requestId:"reconcile-1",artifactIds:[artifactId],verificationIds:[],sourceDiffHash:HASH}))
      .resolves.toMatchObject({reconciliations:[expect.any(Object)]});
    await expect(service.reconcile({runId:"run",expectedRunRevision:reconciled.run.revision,
      requestId:"reconcile-2",artifactIds:[artifactId],verificationIds:[],
      sourceDiffHash:`sha256:${"b".repeat(64)}`})).rejects.toBeInstanceOf(TaskGraphConflictError);
    service.dispose();
  });
});
