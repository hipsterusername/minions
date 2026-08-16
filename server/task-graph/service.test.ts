import "./test-helpers.ts";
import { describe,expect,it,vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import type { Bus } from "../bus.ts";
import type { WsEnvelope } from "../../shared/ws-envelope.ts";
import type { GraphRevisionInput,SourceSnapshot } from "../../shared/task-graph-contracts.ts";
import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import type { AgentHarness } from "../harness/types.ts";
import { initDb } from "../db.ts";
import { ensureWorkItemSchema } from "../work-item-schema.ts";
import { createWorkItem,sealWorkItemRun,startWorkItemIteration } from "../work-item-repo.ts";
import { createChildWorkItemRun,sealChildWorkItemRun } from "../work-item-child-repo.ts";
import { createTaskGraphAgentTools } from "./agent-tools.ts";
import { TaskGraphService } from "./service.ts";
import { activeTaskGraphRunIds } from "./service-execution.ts";
import { validateTaskGraphNodePolicy } from "./execution-policy.ts";

const HASH = `sha256:${"a".repeat(64)}`;
const PACKAGE_BYTES=fs.readFileSync("package.json");
const PACKAGE_HASH=`sha256:${crypto.createHash("sha256").update(PACKAGE_BYTES).digest("hex")}`;

function revision(): GraphRevisionInput {
  return { definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",
    objective:"Ship the graph",acceptanceCriteria:["done"],nonGoals:[],constraints:[],terminalNodeIds:["node"],
    maxActiveAttempts:2,edges:[],nodes:[{ id:"node",title:"Node",objective:"Do it",inputBindings:{},
      outputSchemas:{},constraints:[],acceptanceCriteria:["report done"],executorClass:"standard",
      allowedHarnesses:["codex"],allowedTools:[],ownershipRequest:[],budgetRequest:{},timeoutMs:30_000,
      retryPolicy:{maxAttempts:2,backoffMs:0,retryableOutcomes:["failed","lost"],jitterMs:0},
      verificationRequired:false,failurePolicy:"fail_graph",expansionPolicy:null }] };
}

function source(): SourceSnapshot {
  return { id:"source",workItemId:"work",primaryRunKey:"primary",taskGraphRevisionId:"revision",
    repositoryBaseCommit:"abc",dirtyDiffDigest:HASH,workspaceId:"workspace",worktreeIdentity:"wt",
    systemModelDigest:HASH,workPacketRevisionId:null,connectedContext:[],compiledSkills:[],
    harnessPolicyDigest:HASH,toolPolicyDigest:HASH,createdAt:2 };
}

function fakeBus() {
  const listeners = new Set<(envelope:WsEnvelope)=>void>();
  const emitted: WsEnvelope[] = [];
  const fan = (envelope:WsEnvelope) => { emitted.push(envelope); for (const listener of listeners) listener(envelope); };
  const bus: Bus = { emit:fan,
    emitToSession:(id,payload)=>fan({topic:`session:${id}`,...payload}),
    emitToProject:(id,payload)=>fan({topic:`project:${id}`,...payload}),
    emitToWorkItem:(id,payload)=>fan({topic:`work-item:${id}`,...payload}),
    emitGlobal:(payload)=>fan({topic:"global",...payload}),
    subscribe:(listener)=>{ listeners.add(listener); return () => listeners.delete(listener); },
  };
  return {bus,emitted,fan};
}

function setup() {
  const db = initDb(":memory:"); ensureWorkItemSchema(db);
  createWorkItem(db,{ id:"work",projectId:"project",projectPath:process.cwd(),title:"Work",changeMode:"live",at:1 });
  startWorkItemIteration(db,{ workItemId:"work",runKey:"primary",idempotencyKey:"primary",
    expectedLifecycleRevision:0,expectedCurrentRunKey:null,at:2 });
  return db;
}

describe("TaskGraphService central wiring",() => {
  it("applies deployment harness and tool policy during preflight and persistence",() => {
    const db=setup();const {bus}=fakeBus();const checked:string[]=[];
    const service=new TaskGraphService({db,bus,children:{startChildRun:async(input)=>
      childSnapshot(input.attemptId,input.attemptNumber)},validateNodePolicy:(node)=>{
        checked.push(node.id);
        if (node.allowedHarnesses.includes("unknown")) throw new Error("unknown harness");
      }});
    const invalid=revision();invalid.nodes[0]={...invalid.nodes[0]!,allowedHarnesses:["unknown"]};

    expect(()=>service.validateRevision(invalid)).toThrow("unknown harness");
    expect(()=>service.createRevision(invalid,3)).toThrow("unknown harness");
    expect(checked).toEqual(["node","node"]);
    expect(service.repo.getRevision.bind(service.repo,"revision")).toThrow();
  });

  it("resolves graph tools during child allocation before dispatch acknowledgement",() => {
    const db=setup();const {bus}=fakeBus();
    const service=new TaskGraphService({db,bus,children:{startChildRun:async(input)=>
      childSnapshot(input.attemptId,input.attemptNumber)}});
    const graph=revision();graph.nodes[0]={...graph.nodes[0]!,outputSchemas:{result:{type:"object"}}};
    service.createRevision(graph,3);
    service.repo.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const token=service.scheduler.acquireLease("graph","owner",5,1_000);
    const admission=service.scheduler.schedule({runId:"graph",expectedRunRevision:0,
      ownerId:"owner",fencingToken:token,now:6})[0]!;
    createChildWorkItemRun(db,{workItemId:"work",runKey:"allocating-child",parentRunKey:"primary",
      taskId:"node",attemptId:admission.attemptId,attemptNumber:1,idempotencyKey:"allocate",at:7});

    expect(service.snapshot("graph").attempts[0]).toMatchObject({runtime:"dispatching",session_run_key:null});
    expect(service.agentBinding("allocating-child")).toMatchObject({
      runId:"graph",nodeId:"node",attemptId:admission.attemptId,outputSchemas:{result:{type:"object"}},
    });
    expect(createTaskGraphAgentTools(service,"allocating-child").map(tool=>tool.name))
      .toEqual(["stage_output_artifact"]);
  });

  it("atomically dispatches outbox attempts with the enforced writer sandbox",async() => {
    const db = setup(); const {bus,emitted} = fakeBus();
    const children: Array<Record<string,unknown>> = [];
    const codex={name:"codex",builtInTools:[],capabilities:{mutationInterception:"observe_only",
      builtInFilesystem:true,sandboxEnforcement:{filesystem:["read-only","workspace-write"],approval:true}}} as unknown as AgentHarness;
    const service = new TaskGraphService({ db,bus,now:(() => { let at=10; return () => at++; })(),children:{
      startChildRun:async(input) => { children.push(input); return childSnapshot(input.attemptId,input.attemptNumber); },
    },validateNodePolicy:(node)=>validateTaskGraphNodePolicy(node,()=>codex),resolveHarness:()=>codex});
    const graph=revision();graph.nodes[0]={...graph.nodes[0]!,ownershipRequest:[{
      scope:"path",mode:"write",normalizedValue:"server/task-graph",
    }]};
    service.createRevision(graph,3);
    const result = await service.startRun({ id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4 });
    expect(children).toEqual([expect.objectContaining({ taskId:"node",attemptNumber:1,
      requestId:expect.stringMatching(/^task-graph:attempt_/),
      sandboxPolicy:{filesystemScope:"workspace-write",approvalPolicy:"never"}} )]);
    expect(result.attempts[0]).toMatchObject({ runtime:"running",session_run_key:"child-run" });
    expect(db.prepare("SELECT delivered_at FROM task_scheduler_outbox").get()).toMatchObject({ delivered_at:expect.any(Number) });
    expect(emitted.some(envelope => envelope.type === "task_graph_snapshot")).toBe(true);
    expect(service.viewSnapshot("graph")).toMatchObject({ graphRunId:"graph",status:"running",nodes:[
      expect.objectContaining({ id:"node",readiness:"claimed" }),
    ] });
  });

  it("refreshes skipped and all-terminal edges after an exhausted child launch failure",async() => {
    const db=setup();const {bus}=fakeBus();const launches:string[]=[];
    const service=new TaskGraphService({db,bus,now:()=>10,children:{startChildRun:async(input)=>{
      launches.push(String(input.taskId));
      if (input.taskId==="producer") throw new Error("provider unavailable");
      return childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),
        `child-${String(input.taskId)}`);
    }}});
    const graph=revision();
    graph.maxActiveAttempts=3;
    graph.nodes=[{...graph.nodes[0]!,id:"producer",title:"Producer",failurePolicy:"continue_optional",
      retryPolicy:{...graph.nodes[0]!.retryPolicy,maxAttempts:1}},
    {...graph.nodes[0]!,id:"all-terminal",title:"All terminal"},
    {...graph.nodes[0]!,id:"skip",title:"Skip"}];
    graph.terminalNodeIds=["all-terminal","skip"];
    graph.edges=[
      {id:"terminal-edge",sourceNodeId:"producer",targetNodeId:"all-terminal",kind:"control",
        sourceOutput:null,targetInput:null,satisfactionPolicy:"all_terminal",failurePolicy:"skip",optional:false},
      {id:"skip-edge",sourceNodeId:"producer",targetNodeId:"skip",kind:"control",
        sourceOutput:null,targetInput:null,satisfactionPolicy:"all_success",failurePolicy:"skip",optional:false},
    ];
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});

    expect(launches).toEqual(["producer","all-terminal","skip"]);
    expect(service.snapshot("graph").attempts.find(row=>row["node_id"]==="producer"))
      .toMatchObject({runtime:"terminal",outcome:"failed",backoff_until:null});
    expect(service.snapshot("graph").edgeEvaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({edge_id:"terminal-edge",satisfied:1}),
      expect.objectContaining({edge_id:"skip-edge",satisfied:1,reason:"upstream_failure_skipped"}),
    ]));
  });

  it("keeps retryable child launch failures in backoff without satisfying all-success edges",async() => {
    const db=setup();const {bus}=fakeBus();let at=10;const launches:string[]=[];
    const service=new TaskGraphService({db,bus,now:()=>at,children:{startChildRun:async(input)=>{
      launches.push(String(input.taskId));
      if (input.taskId==="producer") throw new Error("provider unavailable");
      return childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId));
    }}});
    const graph=revision();
    graph.nodes=[{...graph.nodes[0]!,id:"producer",title:"Producer",
      retryPolicy:{...graph.nodes[0]!.retryPolicy,maxAttempts:2,backoffMs:50}},
    {...graph.nodes[0]!,id:"consumer",title:"Consumer"}];
    graph.terminalNodeIds=["consumer"];
    graph.edges=[{id:"strict-edge",sourceNodeId:"producer",targetNodeId:"consumer",kind:"control",
      sourceOutput:null,targetInput:null,satisfactionPolicy:"all_success",failurePolicy:"fail",optional:false}];
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});

    expect(launches).toEqual(["producer"]);
    expect(service.snapshot("graph").attempts[0]).toMatchObject({
      attempt_number:1,runtime:"terminal",outcome:"failed",backoff_until:60,
    });
    expect(service.snapshot("graph").edgeEvaluations)
      .toContainEqual(expect.objectContaining({edge_id:"strict-edge",satisfied:0}));

    at=59;await service.tick("graph");
    expect(launches).toEqual(["producer"]);
    at=60;await service.tick("graph");
    expect(launches).toEqual(["producer","producer"]);
    expect(service.snapshot("graph").run.status).toBe("failed");
    expect(service.snapshot("graph").attempts).toHaveLength(2);
    expect(service.snapshot("graph").edgeEvaluations)
      .toContainEqual(expect.objectContaining({edge_id:"strict-edge",satisfied:0}));
  });

  it("cancels a child allocated after its dispatch fence is lost",async() => {
    const db=setup();const {bus}=fakeBus();const cancelled:string[]=[];
    let releaseLaunch!:(run:WorkItemRunSnapshot)=>void;
    const launch=new Promise<WorkItemRunSnapshot>(resolve=>{releaseLaunch=resolve;});
    const service=new TaskGraphService({db,bus,now:()=>10,children:{
      startChildRun:async()=>launch,
      cancelChildRun:async runKey=>{cancelled.push(runKey);},
    }});
    service.createRevision(revision(),3);
    const starting=service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",
      revisionId:"revision",sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    await vi.waitFor(()=>expect(service.snapshot("graph").attempts[0])
      .toMatchObject({runtime:"dispatching"}));
    await service.cancel("graph",service.snapshot("graph").run.revision);
    const attempt=service.snapshot("graph").attempts[0]!;
    releaseLaunch(childSnapshot(String(attempt["id"]),Number(attempt["attempt_number"]),
      "node","late-child"));
    await starting;

    expect(cancelled).toEqual(["late-child"]);
    expect(service.snapshot("graph").attempts[0]).toMatchObject({
      runtime:"terminal",outcome:"cancelled",session_run_key:null,
    });
  });

  it("cancels a verifier allocated after graph cancellation",async() => {
    const db=setup();const transport=fakeBus();const cancelled:string[]=[];
    let releaseVerifier!:()=>void;
    const verifierGate=new Promise<void>(resolve=>{releaseVerifier=resolve;});
    const service=new TaskGraphService({db,bus:transport.bus,children:{
      startChildRun:async input=>{
        if (!String(input.taskId).endsWith(":verification")) {
          return childSnapshot(input.attemptId,input.attemptNumber,"node","producer-child");
        }
        await verifierGate;
        createChildWorkItemRun(db,{workItemId:input.workItemId,runKey:"late-verifier",
          parentRunKey:input.parentRunKey,taskId:input.taskId,attemptId:input.attemptId,
          attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at:21});
        throw new Error("verifier acknowledgement lost after cancellation");
      },
      cancelChildRun:async runKey=>{cancelled.push(runKey);},
    }});
    service.start();const graph=revision();graph.nodes[0]={...graph.nodes[0]!,
      outputSchemas:{result:{type:"object"}},verificationRequired:true};
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",
      revisionId:"revision",sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const producer=service.snapshot("graph").attempts[0]!;
    service.stageArtifactForSession("producer-child",{schemaName:"Result",schemaVersion:"1",
      contentHash:PACKAGE_HASH,storageRef:"package.json",byteSize:PACKAGE_BYTES.length,
      classification:"internal",retentionPolicy:"keep",outputName:"result",observedWriteSet:[]});
    transport.fan({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{...childSnapshot(String(producer["id"]),1,"node","producer-child"),outcome:"completed",
        endedAt:20,finalReport:"done"},timestamp:20});
    await vi.waitFor(()=>expect(service.snapshot("graph").verificationRequests[0])
      .toMatchObject({status:"launching"}));
    await service.cancel("graph",service.snapshot("graph").run.revision);
    releaseVerifier();

    await vi.waitFor(()=>expect(cancelled).toContain("late-verifier"));
    expect(service.snapshot("graph").verificationRequests[0]).toMatchObject({status:"failed"});
    service.dispose();
  });

  it("bounds cross-graph admission by centrally reported session capacity",async() => {
    const db=setup();const transport=fakeBus();const launches:WorkItemRunSnapshot[]=[];let slots=1;
    const service=new TaskGraphService({db,bus:transport.bus,availableDispatchSlots:()=>slots,
      children:{startChildRun:async(input)=>{
        const child=childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),
          `child-${launches.length+1}`);launches.push(child);slots=0;return child;
      }}});
    service.start();const graph=revision();
    graph.nodes=[graph.nodes[0]!,{...graph.nodes[0]!,id:"node-2",title:"Node 2"}];
    graph.terminalNodeIds=["node","node-2"];
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    expect(launches).toHaveLength(1);
    expect(service.snapshot("graph").attempts).toHaveLength(1);
    expect(service.viewSnapshot("graph").nodes.find(node=>node.id==="node-2")?.blocker)
      .toMatchObject({category:"capacity"});

    slots=1;
    transport.fan({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{...launches[0]!,outcome:"completed",endedAt:20,finalReport:"done"},timestamp:20});
    await vi.waitFor(()=>expect(launches).toHaveLength(2));
    service.dispose();
  });

  it("reconciles a terminal child allocation through normal output validation",async() => {
    const db=setup();const {bus}=fakeBus();
    const service=new TaskGraphService({db,bus,children:{startChildRun:async(input)=>{
      createChildWorkItemRun(db,{workItemId:input.workItemId,runKey:"terminal-child",
        parentRunKey:input.parentRunKey,taskId:input.taskId,attemptId:input.attemptId,
        attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at:8});
      sealChildWorkItemRun(db,{workItemId:input.workItemId,runKey:"terminal-child",outcome:"completed",at:9});
      throw new Error("launch response lost after terminal witness");
    }}});
    const graph=revision();graph.nodes[0]={...graph.nodes[0]!,outputSchemas:{result:{type:"object"}},
      retryPolicy:{...graph.nodes[0]!.retryPolicy,maxAttempts:1}};
    service.createRevision(graph,3);
    const snapshot=await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",
      revisionId:"revision",sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});

    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.attempts[0]).toMatchObject({runtime:"terminal",outcome:"failed",
      session_run_key:"terminal-child"});
  });

  it("turns a sealed child run into a fenced graph terminal event and completes the run",async() => {
    const db = setup(); const transport = fakeBus(); let allocated: WorkItemRunSnapshot | null = null;
    const service = new TaskGraphService({ db,bus:transport.bus,children:{ startChildRun:async(input) => {
      allocated = childSnapshot(input.attemptId,input.attemptNumber); return allocated;
    }}});
    service.start(); service.createRevision(revision(),3);
    await service.startRun({ id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4 });
    transport.fan({ topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{ ...allocated!,outcome:"completed",endedAt:20,finalReport:"done" },timestamp:20 });
    await vi.waitFor(() => expect(service.snapshot("graph").run.status).toBe("completed"));
    expect(service.viewSnapshot("graph")).toMatchObject({ status:"completed",nodes:[
      expect.objectContaining({ logicalState:"succeeded" }),
    ] });
    service.dispose();
  });

  it("lets an operator retry an exhausted decision-blocked node with a fresh attempt",async() => {
    const db=setup();const transport=fakeBus();const allocated:WorkItemRunSnapshot[]=[];
    const service=new TaskGraphService({db,bus:transport.bus,children:{startChildRun:async(input)=>{
      const child=childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),
        `child-${allocated.length+1}`);allocated.push(child);return child;
    }}});
    service.start();const graph=revision();graph.nodes[0]={...graph.nodes[0]!,
      failurePolicy:"block_for_decision",retryPolicy:{...graph.nodes[0]!.retryPolicy,maxAttempts:1}};
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    transport.fan({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{...allocated[0]!,outcome:"error",endedAt:20,finalReport:"failed"},timestamp:20});
    await vi.waitFor(()=>expect(service.snapshot("graph").run.status).toBe("blocked"));
    const failed=service.snapshot("graph").attempts[0]!;

    await service.retryNode({runId:"graph",nodeId:"node",currentAttemptId:String(failed["id"]),
      expectedRunRevision:service.snapshot("graph").run.revision});
    expect(allocated).toHaveLength(2);
    expect(service.snapshot("graph").run.status).toBe("active");
    expect(service.snapshot("graph").attempts[1]).toMatchObject({attempt_number:2,runtime:"running"});
    service.dispose();
  });

  it("durably cancels an expired live child before dispatching its retry",async() => {
    const db=setup();const {bus}=fakeBus();let at=10;const order:string[]=[];let launches=0;
    const service=new TaskGraphService({db,bus,now:()=>at,children:{
      startChildRun:async(input)=>{launches+=1;order.push(`launch:${launches}`);
        return childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),`child-${launches}`);},
      cancelChildRun:async(runKey)=>{order.push(`cancel:${runKey}`);},
    }});
    const graph=revision();graph.nodes[0]={...graph.nodes[0]!,timeoutMs:5,
      retryPolicy:{...graph.nodes[0]!.retryPolicy,backoffMs:0}};
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    at=20;await service.tick("graph");

    expect(order).toEqual(["launch:1","cancel:child-1","launch:2"]);
    expect(service.snapshot("graph").attempts).toEqual([
      expect.objectContaining({attempt_number:1,generation:1,runtime:"terminal",outcome:"lost"}),
      expect.objectContaining({attempt_number:2,generation:2,runtime:"running",outcome:"none"}),
    ]);
    expect(service.snapshot("graph").outbox.find(row=>row["kind"]==="cancel_child"))
      .toMatchObject({delivered_at:20});
    const firstAttemptId=String(service.snapshot("graph").attempts[0]!["id"]);
    expect(service.snapshot("graph").attempts[1]!["id"]).not.toBe(firstAttemptId);
    expect(service.snapshot("graph").reservations.filter(row=>row["attempt_id"]===firstAttemptId
      && !String(row["kind"]).startsWith("budget_")).every(row=>row["released_at"]===20)).toBe(true);
  });

  it("reconciles a durably sealed child before reservation-expiry loss",async() => {
    const db=setup();const {bus}=fakeBus();let at=10;let childAttemptId="";
    const service=new TaskGraphService({db,bus,now:()=>at,children:{startChildRun:async(input)=>{
      childAttemptId=input.attemptId;
      createChildWorkItemRun(db,{workItemId:input.workItemId,runKey:"sealed-child",
        parentRunKey:input.parentRunKey,taskId:input.taskId,attemptId:input.attemptId,
        attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at});
      return childSnapshot(input.attemptId,input.attemptNumber,"node","sealed-child");
    }}});
    const graph=revision();graph.nodes[0]={...graph.nodes[0]!,timeoutMs:5};
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"sealed-child",outcome:"completed",at:12});

    at=20;await service.tick("graph");

    expect(service.snapshot("graph").run.status).toBe("completed");
    expect(service.snapshot("graph").attempts).toEqual([
      expect.objectContaining({id:childAttemptId,attempt_number:1,runtime:"terminal",outcome:"succeeded",
        session_run_key:"sealed-child"}),
    ]);
    expect(service.snapshot("graph").outbox.some(row=>row["kind"]==="cancel_child")).toBe(false);
  });

  it("replays staged output finalization after graph terminalization",async() => {
    const db=setup();const {bus}=fakeBus();const launches:string[]=[];
    const service=new TaskGraphService({db,bus,now:()=>30,children:{startChildRun:async(input)=>{
      const runKey=`child-${launches.length+1}`;launches.push(String(input.taskId));
      createChildWorkItemRun(db,{workItemId:input.workItemId,runKey,parentRunKey:input.parentRunKey,
        taskId:input.taskId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,
        idempotencyKey:input.requestId,at:10});
      return childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),runKey);
    }}});
    const graph=revision();graph.nodes=[{...graph.nodes[0]!,id:"producer",title:"Producer",
      outputSchemas:{result:{type:"object"}}},{...graph.nodes[0]!,id:"consumer",title:"Consumer",
        inputBindings:{result:{type:"object"}}}];
    graph.terminalNodeIds=["consumer"];
    graph.edges=[{id:"result",sourceNodeId:"producer",targetNodeId:"consumer",kind:"artifact",
      sourceOutput:"result",targetInput:"result",satisfactionPolicy:"all_success",
      failurePolicy:"fail",optional:false}];
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const producer=service.snapshot("graph").attempts[0]!;
    service.stageArtifactForSession("child-1",{schemaName:"Result",schemaVersion:"1",
      contentHash:PACKAGE_HASH,storageRef:"package.json",byteSize:PACKAGE_BYTES.length,
      classification:"internal",retentionPolicy:"keep",outputName:"result",observedWriteSet:[]});
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"child-1",outcome:"completed",at:21});
    service.scheduler.terminal({runId:"graph",attemptId:String(producer["id"]),
      generation:Number(producer["generation"]),actorSessionKey:"child-1",
      idempotencyKey:"simulate-terminal-crash",expectedRunRevision:service.snapshot("graph").run.revision,
      at:21},"succeeded",{source:"work_item_run",runKey:"child-1"});

    await service.tick("graph");

    expect(service.snapshot("graph").artifacts[0]).toMatchObject({state:"committed"});
    expect(service.snapshot("graph").edgeEvaluations)
      .toContainEqual(expect.objectContaining({edge_id:"result",satisfied:1}));
    expect(launches).toEqual(["producer","consumer"]);
  });

  it("does not let a late conflicting WorkItem outcome rewrite a terminal graph attempt",async() => {
    const db=setup();const {bus}=fakeBus();
    const service=new TaskGraphService({db,bus,now:()=>30,children:{startChildRun:async(input)=>{
      createChildWorkItemRun(db,{workItemId:input.workItemId,runKey:"late-child",
        parentRunKey:input.parentRunKey,taskId:input.taskId,attemptId:input.attemptId,
        attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at:10});
      return childSnapshot(input.attemptId,input.attemptNumber,"node","late-child");
    }}});
    const graph=revision();graph.nodes[0]={...graph.nodes[0]!,outputSchemas:{result:{type:"object"}},
      retryPolicy:{...graph.nodes[0]!.retryPolicy,maxAttempts:1}};
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const attempt=service.snapshot("graph").attempts[0]!;
    service.stageArtifactForSession("late-child",{schemaName:"Result",schemaVersion:"1",
      contentHash:PACKAGE_HASH,storageRef:"package.json",byteSize:PACKAGE_BYTES.length,
      classification:"internal",retentionPolicy:"keep",outputName:"result",observedWriteSet:[]});
    service.scheduler.terminal({runId:"graph",attemptId:String(attempt["id"]),
      generation:Number(attempt["generation"]),actorSessionKey:"late-child",
      idempotencyKey:"first-terminal-witness",expectedRunRevision:service.snapshot("graph").run.revision,
      at:19},"failed",{source:"scheduler",message:"first outcome"});
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"late-child",outcome:"completed",at:21});

    await service.tick("graph");

    expect(service.snapshot("graph").attempts[0]).toMatchObject({runtime:"terminal",outcome:"failed",
      terminal_witness_json:{source:"scheduler",message:"first outcome"}});
    expect(service.snapshot("graph").artifacts[0]).toMatchObject({state:"rejected"});
  });

  it("serializes simultaneous child terminal events without losing either revision",async() => {
    const db=setup();const transport=fakeBus();const allocated:WorkItemRunSnapshot[]=[];
    const service=new TaskGraphService({db,bus:transport.bus,children:{startChildRun:async(input)=>{
      const child=childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),
        `child-${allocated.length+1}`);allocated.push(child);return child;
    }}});
    service.start();
    const graph=revision();graph.nodes=[graph.nodes[0]!,{...graph.nodes[0]!,id:"node-2",title:"Node 2"}];
    graph.terminalNodeIds=["node","node-2"];
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    expect(allocated).toHaveLength(2);
    for (const child of allocated) transport.fan({topic:"work-item:work",type:"work_item_run_sealed",
      workItemId:"work",run:{...child,outcome:"completed",endedAt:20,finalReport:"done"},timestamp:20});

    await vi.waitFor(()=>expect(service.snapshot("graph").run.status).toBe("completed"));
    expect(service.snapshot("graph").attempts).toEqual([
      expect.objectContaining({runtime:"terminal",outcome:"succeeded"}),
      expect.objectContaining({runtime:"terminal",outcome:"succeeded"}),
    ]);
    service.dispose();
  });

  it("cancels active graph work when its canonical primary WorkItem run seals",async() => {
    const db=setup();const transport=fakeBus();const cancelled:string[]=[];
    const service=new TaskGraphService({db,bus:transport.bus,children:{
      startChildRun:async(input)=>childSnapshot(input.attemptId,input.attemptNumber),
      cancelChildRun:async(runKey)=>{cancelled.push(runKey);},
    }});
    service.start();service.createRevision(revision(),3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    transport.fan({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{runKey:"primary",workItemId:"work",runKind:"primary",parentRunKey:null,taskId:null,
        attemptId:null,attemptNumber:null,runNumber:1,previousRunKey:null,providerSessionId:null,
        outcome:"completed",startedAt:2,endedAt:20,finalReport:"leader done"},timestamp:20});

    await vi.waitFor(()=>expect(service.snapshot("graph").run.status).toBe("cancelled"));
    expect(cancelled).toEqual(["child-run"]);
    expect(service.snapshot("graph").attempts[0]).toMatchObject({runtime:"terminal",outcome:"cancelled"});
    service.dispose();
  });

  it("reconciles a missed durable primary seal before launching graph work",async() => {
    const db=setup();const {bus}=fakeBus();const launches:string[]=[];
    const service=new TaskGraphService({db,bus,children:{startChildRun:async(input)=>{
      launches.push(input.taskId);return childSnapshot(input.attemptId,input.attemptNumber);
    }}});
    service.createRevision(revision(),3);
    service.repo.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    sealWorkItemRun(db,{workItemId:"work",runKey:"primary",outcome:"completed",
      expectedLifecycleRevision:1,expectedCurrentRunKey:"primary",at:5});

    const snapshot=await service.tick("graph");

    expect(snapshot.run.status).toBe("cancelled");
    expect(launches).toEqual([]);
    expect(snapshot.attempts).toEqual([]);
  });

  it("cancels recovered producer children exactly once after a missed primary seal",async() => {
    const db=setup();const {bus}=fakeBus();const cancelled:string[]=[];
    const service=new TaskGraphService({db,bus,now:()=>20,children:{
      startChildRun:async(input)=>childSnapshot(input.attemptId,input.attemptNumber),
      cancelChildRun:async runKey=>{cancelled.push(runKey);},
    }});
    service.createRevision(revision(),3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const attemptId=String(service.snapshot("graph").attempts[0]!["id"]);
    sealWorkItemRun(db,{workItemId:"work",runKey:"primary",outcome:"completed",
      expectedLifecycleRevision:1,expectedCurrentRunKey:"primary",at:10});

    await service.tick("graph");
    await service.tick("graph");

    const snapshot=service.snapshot("graph");
    expect(cancelled).toEqual(["child-run"]);
    expect(snapshot.attempts[0]).toMatchObject({runtime:"terminal",outcome:"cancelled"});
    expect(snapshot.outbox.filter(row=>row["kind"]==="cancel_child")).toHaveLength(1);
    expect(snapshot.reservations.filter(row=>row["attempt_id"]===attemptId
      && !String(row["kind"]).startsWith("budget_")).every(row=>row["released_at"]===20)).toBe(true);
  });

  it("replays terminal producer and verifier cancellation, then leaves the polling set",async() => {
    const db=setup();const {bus}=fakeBus();const launches:string[]=[];
    const graph=revision();graph.nodes=[{...graph.nodes[0]!,retryPolicy:{...graph.nodes[0]!.retryPolicy,
      maxAttempts:1}},{...graph.nodes[0]!,id:"node-2",title:"Node 2"}];
    graph.terminalNodeIds=["node","node-2"];
    const first=new TaskGraphService({db,bus,children:{startChildRun:async(input)=>{
      const runKey=`child-${launches.length+1}`;launches.push(String(input.taskId));
      return childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),runKey);
    }}});first.createRevision(graph,3);
    await first.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const failed=first.snapshot("graph").attempts.find(row=>row["node_id"]==="node")!;
    const sibling=first.snapshot("graph").attempts.find(row=>row["node_id"]==="node-2")!;
    db.prepare(`INSERT INTO task_verification_requests
      (id,run_id,node_id,producer_attempt_id,verifier_attempt_id,verifier_run_key,status,result,
       launch_attempts,next_retry_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',NULL,1,NULL,?,?)`)
      .run("verify","graph","node",failed["id"],"verifier-attempt","verifier-child",10,10);
    first.scheduler.terminal({runId:"graph",attemptId:String(failed["id"]),
      generation:Number(failed["generation"]),actorSessionKey:String(failed["session_run_key"]),idempotencyKey:"terminal-failure",
      expectedRunRevision:first.snapshot("graph").run.revision,at:20},"failed",{reason:"boom"});

    expect(first.snapshot("graph")).toMatchObject({run:{status:"failed"},
      verificationRequests:[{status:"failed",result:"graph terminal"}]});
    expect(first.snapshot("graph").attempts.find(row=>row["id"]===failed["id"]))
      .toMatchObject({outcome:"failed",terminal_witness_json:{reason:"boom"}});
    expect(first.snapshot("graph").attempts.find(row=>row["id"]===sibling["id"]))
      .toMatchObject({outcome:"cancelled",terminal_witness_json:{source:"graph_terminal",status:"failed"}});
    expect(activeTaskGraphRunIds(first)).toContain("graph");
    expect(first.snapshot("graph").outbox.filter(row=>row["kind"]==="cancel_child"
      && row["delivered_at"]==null)).toHaveLength(2);

    const cancelled:string[]=[];const recovered=new TaskGraphService({db,bus,children:{
      startChildRun:async()=>{throw new Error("terminal drain dispatched new work");},
      cancelChildRun:async runKey=>{cancelled.push(runKey);},
    }});await recovered.tick("graph");await recovered.tick("graph");

    expect(cancelled.sort()).toEqual(["child-2","verifier-child"]);
    expect(recovered.snapshot("graph").attempts.find(row=>row["id"]===sibling["id"]))
      .toMatchObject({runtime:"terminal",outcome:"cancelled"});
    expect(recovered.snapshot("graph").outbox.filter(row=>row["delivered_at"]==null)).toEqual([]);
    expect(activeTaskGraphRunIds(recovered)).not.toContain("graph");
    expect(launches).toEqual(["node","node-2"]);
  });

  it("cleans up a sealed bound primary after WorkItem authority advances",async() => {
    const db=setup();const {bus}=fakeBus();const launches:string[]=[];const cancelled:string[]=[];
    const service=new TaskGraphService({db,bus,children:{startChildRun:async(input)=>{
      launches.push(input.taskId);return childSnapshot(input.attemptId,input.attemptNumber);
    },cancelChildRun:async runKey=>{cancelled.push(runKey);}}});
    service.createRevision(revision(),3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    sealWorkItemRun(db,{workItemId:"work",runKey:"primary",outcome:"completed",
      expectedLifecycleRevision:1,expectedCurrentRunKey:"primary",at:5});
    startWorkItemIteration(db,{workItemId:"work",runKey:"new-primary",idempotencyKey:"new-primary",
      expectedLifecycleRevision:2,expectedCurrentRunKey:"primary",at:6});

    const snapshot=await service.tick("graph");

    expect(snapshot.run.status).toBe("cancelled");
    expect(launches).toEqual(["node"]);
    expect(cancelled).toEqual(["child-run"]);
    expect(db.prepare("SELECT current_run_key FROM work_items WHERE id='work'").get())
      .toMatchObject({current_run_key:"new-primary"});
  });

  it("leaves a graph with its exact live primary unchanged",async() => {
    const db=setup();const {bus}=fakeBus();const launches:string[]=[];
    const service=new TaskGraphService({db,bus,children:{startChildRun:async(input)=>{
      launches.push(input.taskId);return childSnapshot(input.attemptId,input.attemptNumber);
    }}});
    service.createRevision(revision(),3);
    service.repo.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});

    const snapshot=await service.tick("graph");

    expect(snapshot.run.status).toBe("active");
    expect(launches).toEqual(["node"]);
    expect(snapshot.attempts[0]).toMatchObject({runtime:"running",session_run_key:"child-run"});
  });

  it.each(["completed","failed","cancelled"] as const)(
    "does not rewrite a %s graph while reconciling a sealed primary",async(status) => {
      const db=setup();const {bus}=fakeBus();
      const service=new TaskGraphService({db,bus,children:{startChildRun:async(input)=>
        childSnapshot(input.attemptId,input.attemptNumber)}});
      service.createRevision(revision(),3);
      service.repo.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
        sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
      db.prepare("UPDATE task_graph_runs SET status=?,revision=7 WHERE id='graph'").run(status);
      sealWorkItemRun(db,{workItemId:"work",runKey:"primary",outcome:"completed",
        expectedLifecycleRevision:1,expectedCurrentRunKey:"primary",at:5});
      const before=service.snapshot("graph");

      const after=await service.tick("graph");

      expect(after.run).toEqual(before.run);
      expect(after.events).toEqual(before.events);
      expect(after.attempts).toEqual(before.attempts);
    },
  );

  it("dispatches downstream nodes with exact committed artifact references",async() => {
    const db=setup();const transport=fakeBus();const launches:Array<Record<string,unknown>>=[];
    const service=new TaskGraphService({db,bus:transport.bus,children:{startChildRun:async(input)=>{
      launches.push(input);return childSnapshot(input.attemptId,input.attemptNumber,
        String(input.taskId),`child-${launches.length}`);
    }}});
    service.start();
    const graph=revision();
    graph.nodes=[{...graph.nodes[0]!,id:"producer",title:"Producer",
      outputSchemas:{result:{type:"object"}}},{...graph.nodes[0]!,id:"consumer",title:"Consumer",
      inputBindings:{result:{type:"object"}},allowedTools:["Read"]}];
    graph.terminalNodeIds=["consumer"];
    graph.edges=[{id:"result",sourceNodeId:"producer",targetNodeId:"consumer",kind:"artifact",
      sourceOutput:"result",targetInput:"result",satisfactionPolicy:"all_success",
      failurePolicy:"fail",optional:false}];
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    expect(launches.map(item=>item.taskId)).toEqual(["producer"]);
    const producer=service.snapshot("graph").attempts[0]!;
    db.prepare("UPDATE task_node_attempts SET attempt_number=2,generation=2 WHERE id=?")
      .run(producer["id"]);
    db.prepare(`INSERT INTO task_node_attempts
      (id,run_id,node_id,attempt_number,generation,source_snapshot_id,runtime,outcome,created_at,updated_at)
      VALUES('historical-attempt','graph','producer',1,1,'source','terminal','succeeded',1,1)`).run();
    db.prepare(`INSERT INTO task_artifacts
      (id,run_id,node_id,producer_attempt_id,source_snapshot_id,output_name,content_hash,metadata_json,
        state,created_at,committed_at) VALUES('zz-historical','graph','producer','historical-attempt',
        'source','result',?,'{}','committed',1,20)`).run(HASH);
    service.stageArtifactForSession("child-1",{schemaName:"Result",schemaVersion:"1",contentHash:PACKAGE_HASH,
      storageRef:"package.json",byteSize:PACKAGE_BYTES.length,classification:"internal",retentionPolicy:"keep",
      outputName:"result",observedWriteSet:[]});
    transport.fan({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{...childSnapshot(String(producer["id"]),1,"producer","child-1"),outcome:"completed",
        endedAt:20,finalReport:"done"},timestamp:20});

    await vi.waitFor(()=>expect(launches).toHaveLength(2));
    expect(launches[1]).toMatchObject({taskId:"consumer",harness:"codex",executorClass:"standard",
      toolAllowlist:["Read"]});
    expect(String(launches[1]!["prompt"])).toContain(`\"contentHash\":\"${PACKAGE_HASH}\"`);
    expect(String(launches[1]!["prompt"])).not.toContain(HASH);
    expect(String(launches[1]!["prompt"])).toContain(PACKAGE_HASH.slice("sha256:".length));
    expect(String(launches[1]!["prompt"])).not.toContain("storageRef");
    expect(String(launches[1]!["prompt"])).not.toContain("artifacts/task-graph");
    const artifacts=service.snapshot("graph").artifacts;
    expect(artifacts).toHaveLength(2);
    const artifactId=String(artifacts.find(item=>item["content_hash"]===PACKAGE_HASH)!["id"]);
    const tools=createTaskGraphAgentTools(service,"child-2");
    expect(tools.map(tool=>tool.name)).toEqual(["read_input_artifact"]);
    const read=await tools[0]!.handler({artifactId,maxBytes:256});
    expect(JSON.parse(read.content[0]!.text)).toMatchObject({artifactId,contentHash:PACKAGE_HASH,
      encoding:"utf8",offset:0,nextOffset:256});
    const stored=db.prepare("SELECT metadata_json FROM task_artifacts WHERE id=?")
      .get(artifactId) as {metadata_json:string};
    db.prepare("UPDATE task_artifacts SET metadata_json=? WHERE id=?")
      .run(JSON.stringify({...JSON.parse(stored.metadata_json),classification:"secret"}),artifactId);
    await expect(tools[0]!.handler({artifactId})).rejects.toThrow(
      "secret artifacts cannot be copied into agent context");
    service.dispose();
  });

  it("stages declared outputs, auto-commits them, and binds an independent verifier verdict",async() => {
    const db=setup();const transport=fakeBus();const launches:Array<Record<string,unknown>>=[];
    const service=new TaskGraphService({db,bus:transport.bus,children:{startChildRun:async(input)=>{
      launches.push(input);
      if (String(input.taskId).endsWith(":verification")) {
        createChildWorkItemRun(db,{workItemId:input.workItemId,runKey:"child-2",
          parentRunKey:input.parentRunKey,taskId:input.taskId,attemptId:input.attemptId,
          attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at:19});
        throw new Error("provider acknowledgement lost after durable allocation");
      }
      return childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),"child-1");
    }}});
    service.start();
    const graph=revision();graph.nodes[0]={...graph.nodes[0]!,outputSchemas:{result:{type:"object"}},verificationRequired:true};
    service.createRevision(graph,3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    const producer=service.snapshot("graph").attempts[0]!;
    expect(service.agentBinding("child-1")).toMatchObject({nodeId:"node",outputSchemas:{result:{type:"object"}}});
    service.stageArtifactForSession("child-1",{schemaName:"Result",schemaVersion:"1",contentHash:PACKAGE_HASH,
      storageRef:"package.json",byteSize:PACKAGE_BYTES.length,classification:"internal",retentionPolicy:"keep",
      outputName:"result",observedWriteSet:[]});
    transport.fan({topic:"work-item:work",type:"work_item_run_sealed",workItemId:"work",
      run:{...childSnapshot(String(producer["id"]),1,"node","child-1"),outcome:"completed",endedAt:20,finalReport:"done"},timestamp:20});
    await vi.waitFor(()=>expect(launches).toHaveLength(2));
    expect(service.snapshot("graph").artifacts[0]).toMatchObject({state:"committed",content_hash:PACKAGE_HASH});
    expect(service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"running",verifier_run_key:"child-2",
    });
    expect(service.viewSnapshot("graph").nodes[0]).toMatchObject({
      logicalState:"pending",verification:{state:"pending"},
    });
    const verifier=launches[1]!;
    expect(String(verifier["prompt"])).not.toContain("storageRef");
    expect(createTaskGraphAgentTools(service,"child-2").map(tool=>tool.name))
      .toEqual(["read_input_artifact"]);
    transport.fan({topic:`session:${String(verifier["attemptId"])}`,type:"minion_status",
      minionSessionKey:"child-2",trigger:"done",
      message:JSON.stringify({result:"passed",confidence:0.9,summary:"valid"}),timestamp:30});
    // Simulate a server crash window: the WorkItem terminal witness is durable,
    // but its bus event was never observed by this graph service instance.
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"child-2",outcome:"completed",at:31});
    await service.tick("graph");
    await vi.waitFor(()=>expect(service.viewSnapshot("graph")).toMatchObject({status:"completed",nodes:[
      expect.objectContaining({logicalState:"succeeded",verification:expect.objectContaining({state:"passed"})}),
    ]}));
    expect(transport.emitted.some(envelope=>envelope.type==="task_graph_changed"
      && Array.isArray(envelope["changes"] && (envelope["changes"] as Record<string,unknown>)["nodes"])
      && ((envelope["changes"] as {nodes:Array<Record<string,unknown>>}).nodes)
        .some(node=>node["id"]==="node"
          && (node["verification"] as Record<string,unknown>)["state"]==="passed"))).toBe(true);
    expect(service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"completed",result:"passed",
    });
    expect(service.snapshot("graph").outbox.filter(row=>row["delivered_at"]==null)).toEqual([]);
    expect(activeTaskGraphRunIds(service)).not.toContain("graph");
    service.dispose();
  });

  it("recovers only stale or durably allocated launching verifier requests",async() => {
    async function recoveryCase(kind:"ended"|"stale"|"fresh"|"unrelated") {
      const db=setup();const {bus}=fakeBus();let at=60_001;let verifierLaunches=0;
      const service=new TaskGraphService({db,bus,now:()=>at,children:{startChildRun:async(input)=>{
        if (String(input.taskId).endsWith(":verification")) {
          verifierLaunches+=1;
          const runKey=`relaunched-verifier-${verifierLaunches}`;
          createChildWorkItemRun(db,{workItemId:input.workItemId,runKey,parentRunKey:input.parentRunKey,
            taskId:input.taskId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,
            idempotencyKey:input.requestId,at});
          return childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),runKey);
        }
        createChildWorkItemRun(db,{workItemId:input.workItemId,runKey:"producer-child",
          parentRunKey:input.parentRunKey,taskId:input.taskId,attemptId:input.attemptId,
          attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at:5});
        return childSnapshot(input.attemptId,input.attemptNumber,String(input.taskId),"producer-child");
      }}});
      const graph=revision();graph.nodes[0]={...graph.nodes[0]!,
        outputSchemas:{result:{type:"object"}},verificationRequired:true};
      service.createRevision(graph,3);
      await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
        sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
      const producer=service.snapshot("graph").attempts[0]!;
      db.prepare(`UPDATE task_node_attempts SET runtime='terminal',outcome='succeeded',updated_at=10
        WHERE id=?`).run(producer["id"]);
      db.prepare(`INSERT INTO task_artifacts
        (id,run_id,node_id,producer_attempt_id,source_snapshot_id,output_name,content_hash,
          metadata_json,state,created_at,committed_at)
        VALUES('artifact-recovery','graph','node',?,'source','result',?,?,'committed',9,10)`)
        .run(producer["id"],PACKAGE_HASH,JSON.stringify({schemaName:"Result",schemaVersion:"1",
          classification:"internal",byteSize:PACKAGE_BYTES.length}));
      const verifierAttemptId="verifier-recovery";
      const updatedAt=kind==="fresh"?60_000:1;
      db.prepare(`INSERT INTO task_verification_requests
        (id,run_id,node_id,producer_attempt_id,verifier_attempt_id,status,created_at,updated_at)
        VALUES('request-recovery','graph','node',?,?,'launching',1,?)`)
        .run(producer["id"],verifierAttemptId,updatedAt);
      if (kind==="ended" || kind==="unrelated") {
        createChildWorkItemRun(db,{workItemId:"work",runKey:"allocated-verifier",parentRunKey:"primary",
          taskId:kind==="ended"?"node:verification":"other:verification",attemptId:verifierAttemptId,
          attemptNumber:1,idempotencyKey:`task-graph-verifier:${verifierAttemptId}`,at:20});
      }
      if (kind==="ended") sealChildWorkItemRun(db,{workItemId:"work",runKey:"allocated-verifier",
        outcome:"completed",finalReport:JSON.stringify({result:"passed",confidence:0.8}),at:30});
      return {db,service,setAt:(value:number)=>{at=value;},launches:()=>verifierLaunches};
    }

    const ended=await recoveryCase("ended");
    await ended.service.tick("graph");
    expect(ended.service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"completed",verifier_run_key:"allocated-verifier",result:"passed",
    });
    expect(ended.launches()).toBe(0);

    const stale=await recoveryCase("stale");
    await stale.service.tick("graph");
    expect(stale.service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"pending",launch_attempts:1,next_retry_at:61_001,
    });
    stale.setAt(61_001);
    await stale.service.tick("graph");
    await stale.service.tick("graph");
    expect(stale.launches()).toBe(1);
    expect(stale.service.snapshot("graph").verificationRequests[0]).toMatchObject({
      status:"running",verifier_run_key:"relaunched-verifier-1",
    });

    for (const kind of ["fresh","unrelated"] as const) {
      const current=await recoveryCase(kind);
      await current.service.tick("graph");
      expect(current.launches()).toBe(0);
      expect(current.service.snapshot("graph").verificationRequests[0]).toMatchObject({
        status:"launching",verifier_run_key:null,launch_attempts:0,
      });
    }
  });
});

function childSnapshot(attemptId:string,attemptNumber:number,taskId="node",runKey="child-run"): WorkItemRunSnapshot {
  return { runKey,workItemId:"work",runKind:"child",parentRunKey:"primary",taskId,
    attemptId,attemptNumber,runNumber:null,previousRunKey:null,providerSessionId:null,outcome:"none",
    startedAt:10,endedAt:null,finalReport:null };
}
