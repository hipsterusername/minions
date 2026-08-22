import "./test-helpers.ts";
import { describe,expect,it } from "vitest";
import type { GraphRevisionInput,SourceSnapshot } from "../../shared/task-graph-contracts.ts";
import { initDb } from "../db.ts";
import { ensureWorkItemSchema } from "../work-item-schema.ts";
import { createWorkItem,startWorkItemIteration } from "../work-item-repo.ts";
import { storeScopedContextSources } from "./context-sources.ts";
import { TaskGraphRepository } from "./repository.ts";

const HASH=`sha256:${"a".repeat(64)}`;

function revision():GraphRevisionInput {
  return {definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",
    objective:"Inspect",acceptanceCriteria:["done"],nonGoals:[],constraints:[],terminalNodeIds:["node"],
    maxActiveAttempts:1,edges:[],nodes:[{id:"node",title:"Node",objective:"Do useful work",
      inputBindings:{},outputSchemas:{},constraints:[],acceptanceCriteria:["report"],executorClass:"standard",
      allowedHarnesses:["codex"],allowedTools:[],ownershipRequest:[],budgetRequest:{},timeoutMs:1_000,
      retryPolicy:{maxAttempts:1,backoffMs:0,retryableOutcomes:["failed"],jitterMs:0},
      verificationRequired:false,failurePolicy:"fail_graph",expansionPolicy:null}]};
}

function source():SourceSnapshot {
  return {id:"source",workItemId:"work",primaryRunKey:"primary",taskGraphRevisionId:"revision",
    repositoryBaseCommit:"abc",dirtyDiffDigest:HASH,workspaceId:"workspace",worktreeIdentity:"wt",
    systemModelDigest:HASH,workPacketRevisionId:null,connectedContext:[],compiledSkills:[],
    harnessPolicyDigest:HASH,toolPolicyDigest:HASH,createdAt:2};
}

describe("TaskGraphRepository view data",()=>{
  it("loads frozen node context and durable attempt final reports into the canonical snapshot",()=>{
    const db=initDb(":memory:");ensureWorkItemSchema(db);
    createWorkItem(db,{id:"work",projectId:"project",projectPath:process.cwd(),title:"Work",changeMode:"live",at:1});
    startWorkItemIteration(db,{workItemId:"work",runKey:"primary",idempotencyKey:"primary",
      expectedLifecycleRevision:0,expectedCurrentRunKey:null,at:2});
    const repo=new TaskGraphRepository(db);repo.createRevision(revision(),3);
    repo.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:1,at:4});
    storeScopedContextSources(db,[{sourceSnapshotId:"source",nodeId:"node",sourceId:"brief",
      contentHash:HASH,classification:"internal",content:"Frozen task context"}],5);
    db.prepare(`INSERT INTO sessions (session_key,status,role,final_report)
      VALUES ('child','completed','minion','Implemented and verified')`).run();
    db.prepare(`INSERT INTO task_node_attempts
      (id,run_id,node_id,attempt_number,generation,source_snapshot_id,runtime,outcome,session_run_key,
       progress_seq,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("attempt","run","node",1,1,"source","terminal","succeeded","child",0,6,7);

    const snapshot=repo.snapshot("run");

    expect(snapshot.contextSources).toEqual([{nodeId:"node",sourceId:"brief",contentHash:HASH,
      classification:"internal",content:"Frozen task context"}]);
    expect(snapshot.attempts[0]).toMatchObject({id:"attempt",final_report:"Implemented and verified"});
  });
});
