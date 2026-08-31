import "./test-helpers.ts";
import { describe,expect,it } from "vitest";
import type { Bus } from "../bus.ts";
import { initDb } from "../db.ts";
import { createChildWorkItemRun,sealChildWorkItemRun } from "../work-item-child-repo.ts";
import { ensureWorkItemSchema } from "../work-item-schema.ts";
import { createWorkItem,startWorkItemIteration } from "../work-item-repo.ts";
import type { GraphRevisionInput,SourceSnapshot } from "../../shared/task-graph-contracts.ts";
import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import type { WsEnvelope } from "../../shared/ws-envelope.ts";
import { createTaskGraphAgentTools } from "./agent-tools.ts";
import { TaskGraphService } from "./service.ts";

const HASH=`sha256:${"a".repeat(64)}`;
const RESULT_SCHEMA={type:"object",additionalProperties:false,required:["value"],
  properties:{value:{type:"string"}},example:{value:"first"}};

describe("task graph provider-thread affinity",()=>{
  it("resumes the prior successful provider thread without reusing attempt identity",async()=>{
    const db=setup();const bus=fakeBus();const launches:Array<Record<string,unknown>>=[];
    let childNumber=0;
    const service=new TaskGraphService({db,bus,children:{startChildRun:async input=>{
      childNumber+=1;const runKey=`child-${childNumber}`;launches.push(input);
      createChildWorkItemRun(db,{workItemId:input.workItemId,runKey,
        parentRunKey:input.parentRunKey,taskId:input.taskId,attemptId:input.attemptId,
        attemptNumber:input.attemptNumber,idempotencyKey:input.requestId,at:10+childNumber});
      db.prepare(`UPDATE sessions SET session_id=?,harness_name=?,model=? WHERE session_key=?`)
        .run(`provider-${childNumber}`,input.harness??"codex",input.model??"reasoning-model",runKey);
      return child(runKey,input.taskId,input.attemptId,input.attemptNumber);
    }}});
    service.createRevision(revision(),3);
    await service.startRun({id:"graph",workItemId:"work",primaryRunKey:"primary",
      revisionId:"revision",sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});

    expect(launches[0]).toMatchObject({taskId:"turn-1",model:"reasoning-model"});
    expect(launches[0]).not.toHaveProperty("resumeId");
    expect(createTaskGraphAgentTools(service,"child-1").map(tool=>tool.name))
      .toEqual(["read_input_artifact","stage_output_artifact"]);
    await createTaskGraphAgentTools(service,"child-1").find(tool=>
      tool.name==="stage_output_artifact")!.handler({source:"inline",
        inlineJson:{value:"first"},outputName:"result"});
    sealChildWorkItemRun(db,{workItemId:"work",runKey:"child-1",outcome:"completed",
      finalReport:"first",at:20});
    await service.tick("graph");

    expect(launches[1]).toMatchObject({taskId:"turn-2",resumeId:"provider-1",
      invocationKind:"resume_open_run",harness:"codex",model:"reasoning-model"});
    expect(service.snapshot("graph").attempts.map(row=>row["session_run_key"]))
      .toEqual(["child-1","child-2"]);
  });

  it("rejects unordered or runtime-incompatible affinity chains",()=>{
    const db=setup();const service=new TaskGraphService({db,bus:fakeBus(),children:{
      startChildRun:async input=>child("unused",input.taskId,input.attemptId,input.attemptNumber),
    }});
    const unordered=revision();unordered.edges=[];
    expect(()=>service.validateRevision(unordered)).toThrow("totally ordered");
    const changed=revision();changed.nodes[1]={...changed.nodes[1]!,model:"other-model"};
    expect(()=>service.validateRevision(changed)).toThrow("changes harness, model, tools");
  });
});

function revision():GraphRevisionInput {
  const node=(id:string,sequence:number):GraphRevisionInput["nodes"][number]=>({
    id,title:id,objective:id,inputBindings:{result:RESULT_SCHEMA},outputSchemas:{result:RESULT_SCHEMA},
    constraints:[],acceptanceCriteria:["done"],executorClass:"reasoning",
    allowedHarnesses:["codex"],model:"reasoning-model",sessionAffinity:{key:"participant-a",
      sequence,cacheMode:"provider_thread"},allowedTools:[],ownershipRequest:[],budgetRequest:{},
    timeoutMs:30_000,retryPolicy:{maxAttempts:2,backoffMs:0,retryableOutcomes:["failed"],
      jitterMs:0},verificationRequired:false,failurePolicy:"fail_graph",expansionPolicy:null,
  });
  return {definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",
    objective:"Reason",acceptanceCriteria:["done"],nonGoals:[],constraints:[],
    terminalNodeIds:["turn-2"],maxActiveAttempts:1,nodes:[node("turn-1",0),node("turn-2",1)],
    edges:[{id:"edge",sourceNodeId:"turn-1",targetNodeId:"turn-2",kind:"artifact",
      sourceOutput:"result",targetInput:"result",satisfactionPolicy:"all_success",
      failurePolicy:"block",optional:false}]};
}

function source():SourceSnapshot {
  return {id:"source",workItemId:"work",primaryRunKey:"primary",taskGraphRevisionId:"revision",
    repositoryBaseCommit:"abc",dirtyDiffDigest:HASH,workspaceId:"workspace",worktreeIdentity:"wt",
    systemModelDigest:HASH,workPacketRevisionId:null,connectedContext:[],compiledSkills:[],
    harnessPolicyDigest:HASH,toolPolicyDigest:HASH,createdAt:2};
}

function setup() {
  const db=initDb(":memory:");ensureWorkItemSchema(db);
  createWorkItem(db,{id:"work",projectId:"project",projectPath:process.cwd(),title:"Work",
    changeMode:"live",at:1});
  startWorkItemIteration(db,{workItemId:"work",runKey:"primary",idempotencyKey:"primary",
    expectedLifecycleRevision:0,expectedCurrentRunKey:null,at:2});
  return db;
}

function fakeBus():Bus {
  const listeners=new Set<(event:WsEnvelope)=>void>();
  const emit=(event:WsEnvelope)=>{for(const listener of listeners) listener(event);};
  return {emit,emitToSession:(id,payload)=>emit({topic:`session:${id}`,...payload}),
    emitToProject:(id,payload)=>emit({topic:`project:${id}`,...payload}),
    emitToWorkItem:(id,payload)=>emit({topic:`work-item:${id}`,...payload}),
    emitGlobal:payload=>emit({topic:"global",...payload}),
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
}

function child(runKey:string,taskId:string,attemptId:string,
  attemptNumber:number):WorkItemRunSnapshot {
  return {runKey,workItemId:"work",runKind:"child",parentRunKey:"primary",taskId,
    attemptId,attemptNumber,runNumber:null,previousRunKey:null,providerSessionId:null,
    outcome:"none",startedAt:10,endedAt:null,finalReport:null};
}
