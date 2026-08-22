import "../../server/task-graph/test-helpers.ts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { GraphRevisionInput, SourceSnapshot, TaskNode } from "../../shared/task-graph-contracts.ts";
import { TaskGraphConflictError, TaskGraphEvidence, TaskGraphRecovery, TaskGraphRepository,
  TaskGraphScheduler, TaskGraphValidationError } from "../../server/task-graph/index.ts";

const H = `sha256:${"a".repeat(64)}`; const H2 = `sha256:${"b".repeat(64)}`;
function node(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return { id,title:id,objective:`do ${id}`,inputBindings:{},outputSchemas:{},constraints:[],acceptanceCriteria:[],
    executorClass:"standard",allowedHarnesses:["codex"],allowedTools:[],ownershipRequest:[],budgetRequest:{},
    timeoutMs:1_000,retryPolicy:{maxAttempts:2,backoffMs:10,retryableOutcomes:["failed","lost"],jitterMs:0},
    verificationRequired:false,failurePolicy:"fail_graph",expansionPolicy:null,...extra };
}
function spec(nodes: TaskNode[], edges: GraphRevisionInput["edges"] = [], max = 4): GraphRevisionInput {
  return { definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",objective:"mission",
    acceptanceCriteria:["done"],nonGoals:[],constraints:[],terminalNodeIds:[nodes.at(-1)!.id],nodes,edges,maxActiveAttempts:max };
}
function source(): SourceSnapshot {
  return { id:"source",workItemId:"work",primaryRunKey:"primary",taskGraphRevisionId:"revision",
    repositoryBaseCommit:"abc",dirtyDiffDigest:H,workspaceId:"workspace",worktreeIdentity:"wt",systemModelDigest:H,
    workPacketRevisionId:null,connectedContext:[],compiledSkills:[],harnessPolicyDigest:H,toolPolicyDigest:H,createdAt:1 };
}
function setup(graph = spec([node("a")])) {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE work_items(id TEXT PRIMARY KEY,lifecycle_revision INTEGER,current_run_key TEXT)");
  db.prepare("INSERT INTO work_items VALUES('work',7,'primary')").run();
  const repo = new TaskGraphRepository(db); repo.createRevision(graph,1);
  repo.startRun({ id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
    sourceSnapshot:source(),expectedLifecycleRevision:7,at:2 });
  return { db,repo,scheduler:new TaskGraphScheduler(repo),evidence:new TaskGraphEvidence(repo) };
}
function event(runRevision:number,attempt:{attemptId:string;generation:number},key:string,at:number,actor="actor") {
  return { runId:"run",attemptId:attempt.attemptId,generation:attempt.generation,actorSessionKey:actor,
    idempotencyKey:key,expectedRunRevision:runRevision,at };
}

describe("canonical task graph runtime", () => {
  it("rejects cycles and preserves immutable revision facts", () => {
    const db = new Database(":memory:"); const repo = new TaskGraphRepository(db);
    const cyclic = spec([node("a"),node("b")],[
      {id:"ab",sourceNodeId:"a",targetNodeId:"b",kind:"control",sourceOutput:null,targetInput:null,satisfactionPolicy:"all_success",failurePolicy:"fail",optional:false},
      {id:"ba",sourceNodeId:"b",targetNodeId:"a",kind:"control",sourceOutput:null,targetInput:null,satisfactionPolicy:"all_success",failurePolicy:"fail",optional:false},
    ]);
    expect(() => repo.createRevision(cyclic,1)).toThrow(TaskGraphValidationError);
    const initial = spec([node("a")]); repo.createRevision(initial,1);
    expect(repo.createRevision(initial,2)).toEqual(initial);
    expect(() => repo.createRevision({ ...initial,objective:"changed" },3)).toThrow(TaskGraphConflictError);
  });

  it("rejects unsafe ownership paths and incompatible artifact bindings",() => {
    const db=new Database(":memory:");const repo=new TaskGraphRepository(db);
    expect(()=>repo.createRevision(spec([node("unsafe",{
      ownershipRequest:[{scope:"path",mode:"write",normalizedValue:"src/**"}],
    })]),1)).toThrow(TaskGraphValidationError);
    const producer=node("producer",{outputSchemas:{result:{type:"object"}}});
    const consumer=node("consumer",{inputBindings:{result:{type:"string"}}});
    expect(()=>repo.createRevision(spec([producer,consumer],[{id:"result",sourceNodeId:"producer",
      targetNodeId:"consumer",kind:"artifact",sourceOutput:"result",targetInput:"result",
      satisfactionPolicy:"all_success",failurePolicy:"fail",optional:false}]),2))
      .toThrow(TaskGraphValidationError);
    expect(()=>repo.createRevision({...spec([node("verification",{completionMode:"verification"})]),
      revisionId:"verification-without-criteria"},3)).toThrow("declares no acceptance criteria");
  });

  it("does not satisfy a verification-mode terminal from a succeeded row with a negative verdict",()=>{
    const verification=node("verification",{completionMode:"verification",
      acceptanceCriteria:["checks pass"]});
    const {repo,scheduler,evidence}=setup(spec([verification]));
    const token=scheduler.acquireLease("run","owner",3,100);
    const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",
      fencingToken:token,now:4})[0]!;
    scheduler.acknowledgeDispatch(event(1,attempt,"ack",5),"child");
    const finalReport=JSON.stringify({result:"failed",confidence:1});
    scheduler.terminal(event(2,attempt,"done",6,"child"),"succeeded",{
      source:"work_item_run",runKey:"child",finalReport,
      completionVerdict:{result:"failed",confidence:1},
    });

    evidence.evaluate("run",repo.snapshot("run",0).run.revision,7);

    expect(repo.snapshot("run").run.status).not.toBe("completed");
    expect(repo.snapshot("run").attempts[0]).toMatchObject({outcome:"succeeded",
      source_snapshot_id:"source"});
  });

  it("reconstructs a normalized snapshot with a frozen deterministic join", () => {
    const graph = spec([node("a"),node("b"),node("join")],["a","b"].map(id => ({ id:`${id}-join`,sourceNodeId:id,
      targetNodeId:"join",kind:"control" as const,sourceOutput:null,targetInput:null,satisfactionPolicy:"all_success" as const,
      failurePolicy:"fail" as const,optional:false })));
    const { repo } = setup(graph); const snapshot = repo.snapshot("run");
    expect(snapshot.revision.nodes.map(n=>n.id)).toEqual(["a","b","join"]);
    expect(snapshot.joins).toEqual([expect.objectContaining({ node_id:"join",policy:"all_success",cohort_json:["a","b"] })]);
    expect(snapshot.events[0]).toMatchObject({ type:"run_started",runRevision:0 });
  });

  it("accepts exact replays and serial runs while rejecting a second active graph",() => {
    const {db,repo}=setup();
    expect(repo.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:7,at:3}).run.id).toBe("run");
    expect(()=>repo.startRun({id:"other",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:7,at:4})).toThrow(TaskGraphConflictError);
    expect(()=>repo.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:{...source(),repositoryBaseCommit:"changed"},expectedLifecycleRevision:7,at:5}))
      .toThrow(TaskGraphConflictError);

    db.prepare("UPDATE task_graph_runs SET status='completed' WHERE id='run'").run();
    const successor={...spec([node("next")]),revisionId:"revision-2"};
    const successorSource={...source(),id:"source-2",taskGraphRevisionId:"revision-2",createdAt:6};
    repo.createRevision(successor,6);
    expect(repo.startRun({id:"other",workItemId:"work",primaryRunKey:"primary",
      revisionId:"revision-2",sourceSnapshot:successorSource,
      expectedLifecycleRevision:7,at:7}).run.id).toBe("other");
    expect(repo.snapshot("run").run.status).toBe("completed");
    expect(()=>repo.startRun({id:"third",workItemId:"work",primaryRunKey:"primary",
      revisionId:"revision-2",sourceSnapshot:{...successorSource,id:"source-3",createdAt:8},
      expectedLifecycleRevision:7,at:8})).toThrow("cancel it before starting a successor");
  });

  it("atomically admits attempts, reservations, and dispatch outbox under a scheduler fence", () => {
    const { db,repo,scheduler } = setup(spec([node("a"),node("b"),node("c")],[],2));
    const token = scheduler.acquireLease("run","owner",3,100);
    const admitted = scheduler.schedule({ runId:"run",expectedRunRevision:0,ownerId:"owner",fencingToken:token,now:4 });
    expect(admitted).toHaveLength(2);
    expect((db.prepare("SELECT count(*) n FROM task_node_attempts").get() as {n:number}).n).toBe(2);
    expect((db.prepare("SELECT count(*) n FROM task_resource_reservations").get() as {n:number}).n).toBe(2);
    expect((db.prepare("SELECT count(*) n FROM task_scheduler_outbox").get() as {n:number}).n).toBe(2);
    expect(repo.snapshot("run").run.revision).toBe(1);
    expect(() => scheduler.schedule({ runId:"run",expectedRunRevision:0,ownerId:"owner",fencingToken:token,now:5 }))
      .toThrow(TaskGraphConflictError);
  });

  it("enforces overlapping write ownership and cumulative budget admission", () => {
    const a = node("a",{ ownershipRequest:[{scope:"path",mode:"write",normalizedValue:"src"}],
      budgetRequest:{costMicros:60} });
    const b = node("b",{ ownershipRequest:[{scope:"path",mode:"write",normalizedValue:"src/feature"}],
      budgetRequest:{costMicros:60} });
    const c = node("c",{ ownershipRequest:[{scope:"path",mode:"write",normalizedValue:"docs"}],
      budgetRequest:{costMicros:40} });
    const graph = { ...spec([a,b,c],[],3),budgetLimits:{tokenLimit:null,costMicrosLimit:100} };
    const {db,scheduler} = setup(graph); const token=scheduler.acquireLease("run","owner",3,100);
    const admitted=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",fencingToken:token,now:4});
    expect(admitted.map(item=>item.nodeId)).toEqual(["a","c"]);
    expect((db.prepare("SELECT sum(amount) amount FROM task_resource_reservations WHERE kind='budget_cost_micros'")
      .get() as {amount:number}).amount).toBe(100);
    expect(db.prepare("SELECT count(*) n FROM task_node_attempts WHERE node_id='b'").get()).toEqual({n:0});
    expect(scheduler.inspect("run",5).find(item=>item.nodeId==="b"))
      .toMatchObject({ready:false,reason:"budget_cost"});
  });

  it("enforces ownership overlap across WorkItems sharing a workspace",() => {
    const db=new Database(":memory:");db.pragma("foreign_keys=ON");
    db.exec("CREATE TABLE work_items(id TEXT PRIMARY KEY,lifecycle_revision INTEGER,current_run_key TEXT)");
    db.prepare("INSERT INTO work_items VALUES(?,?,?)").run("work",7,"primary");
    db.prepare("INSERT INTO work_items VALUES(?,?,?)").run("other-work",7,"other-primary");
    const repo=new TaskGraphRepository(db);
    const writer=node("writer",{ownershipRequest:[{scope:"path",mode:"write",normalizedValue:"src"}]});
    repo.createRevision(spec([writer]),1);
    repo.startRun({id:"run",workItemId:"work",primaryRunKey:"primary",revisionId:"revision",
      sourceSnapshot:source(),expectedLifecycleRevision:7,at:2});
    const otherSpec={...spec([{...writer,id:"other-writer"}]),definitionId:"other-definition",
      revisionId:"other-revision",workItemId:"other-work",terminalNodeIds:["other-writer"]};
    const otherSource={...source(),id:"other-source",workItemId:"other-work",
      primaryRunKey:"other-primary",taskGraphRevisionId:"other-revision"};
    repo.createRevision(otherSpec,1);
    repo.startRun({id:"other-run",workItemId:"other-work",primaryRunKey:"other-primary",
      revisionId:"other-revision",sourceSnapshot:otherSource,expectedLifecycleRevision:7,at:2});
    const scheduler=new TaskGraphScheduler(repo);
    const firstToken=scheduler.acquireLease("run","owner",3,100);
    expect(scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",
      fencingToken:firstToken,now:4})).toHaveLength(1);
    const secondToken=scheduler.acquireLease("other-run","owner",3,100);

    expect(scheduler.schedule({runId:"other-run",expectedRunRevision:0,ownerId:"owner",
      fencingToken:secondToken,now:4})).toHaveLength(0);
    expect(scheduler.inspect("other-run",4)[0]).toMatchObject({
      ready:false,reason:"ownership_conflict",
    });
  });

  it("requires observed artifact writes to hold a canonical write lease",() => {
    const producer=node("producer",{outputSchemas:{result:{type:"object",schemaName:"Result",schemaVersion:"1"}},
      ownershipRequest:[{scope:"path",mode:"write",normalizedValue:"src"}]});
    const {repo,scheduler,evidence}=setup(spec([producer]));
    const token=scheduler.acquireLease("run","owner",3,100);
    const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",fencingToken:token,now:4})[0]!;
    scheduler.acknowledgeDispatch(event(1,attempt,"ack",5),"child");
    const artifact={id:"artifact",schemaName:"Result",schemaVersion:"1",contentHash:H2,
      storageRef:"artifacts/result",byteSize:1,classification:"internal" as const,
      retentionPolicy:"keep",outputName:"result",observedWriteSet:["src/result.ts"]};
    expect(evidence.stageArtifact(event(2,attempt,"stage",6,"child"),artifact)).toBe(true);
    expect(()=>evidence.stageArtifact(event(3,attempt,"other-output",7,"child"),{
      ...artifact,id:"other",contentHash:H,observedWriteSet:["../escape"]})).toThrow(TaskGraphValidationError);
    expect(()=>evidence.stageArtifact(event(3,attempt,"replace",7,"child"),{
      ...artifact,id:"replacement",contentHash:H})).toThrow(TaskGraphConflictError);
    expect(repo.snapshot("run").artifacts).toHaveLength(1);
  });

  it("applies frozen any-success join membership deterministically", () => {
    const edges = ["a","b"].map(id => ({ id:`${id}-join`,sourceNodeId:id,targetNodeId:"join",kind:"control" as const,
      sourceOutput:null,targetInput:null,satisfactionPolicy:"any_success" as const,failurePolicy:"fail" as const,optional:false }));
    const { db,scheduler } = setup(spec([node("a"),node("b"),node("join")],edges));
    db.prepare("INSERT INTO task_edge_evaluations VALUES(?,?,?,?,?,?,?)")
      .run("run","a-join",1,"satisfied",H,0,3);
    expect(scheduler.inspect("run",4).find(item=>item.nodeId==="join")).toMatchObject({ready:true,reason:"ready"});
    db.prepare("UPDATE task_edge_evaluations SET satisfied=0 WHERE edge_id='a-join'").run();
    expect(scheduler.inspect("run",4).find(item=>item.nodeId==="join")).toMatchObject({ready:false,reason:"join_unsatisfied:0/1"});
  });

  it("counts distinct frozen cohort members for quorum joins", () => {
    const quorumEdge = (id:string,sourceNodeId:string) => ({
      id,sourceNodeId,targetNodeId:"join",kind:"control" as const,sourceOutput:null,targetInput:null,
      satisfactionPolicy:"quorum" as const,quorum:2,failurePolicy:"fail" as const,optional:false,
    });
    const edges = [quorumEdge("a-first","a"),quorumEdge("a-second","a"),quorumEdge("b-join","b")];
    const { db,repo,scheduler } = setup(spec([node("a"),node("b"),node("join")],edges));
    const evaluate = db.prepare("INSERT INTO task_edge_evaluations VALUES(?,?,?,?,?,?,?)");
    evaluate.run("run","a-first",1,"satisfied",H,0,3);
    evaluate.run("run","a-second",1,"satisfied",H,0,3);
    evaluate.run("run","b-join",0,"unsatisfied",H,0,3);

    expect(repo.snapshot("run").joins).toEqual([
      expect.objectContaining({node_id:"join",policy:"quorum",quorum:2,cohort_json:["a","b"]}),
    ]);
    expect(scheduler.inspect("run",4).find(item=>item.nodeId==="join"))
      .toMatchObject({ready:false,reason:"join_unsatisfied:1/2"});

    db.prepare("UPDATE task_edge_evaluations SET satisfied=1 WHERE edge_id='b-join'").run();
    db.prepare("UPDATE task_edge_evaluations SET satisfied=0 WHERE edge_id='a-second'").run();
    expect(scheduler.inspect("run",5).find(item=>item.nodeId==="join"))
      .toMatchObject({ready:false,reason:"join_unsatisfied:1/2"});

    db.prepare("UPDATE task_edge_evaluations SET satisfied=1 WHERE edge_id='a-second'").run();
    expect(scheduler.inspect("run",6).find(item=>item.nodeId==="join"))
      .toMatchObject({ready:true,reason:"ready"});
  });

  it("deduplicates events, rejects stale generations, and retries with a fresh identity", () => {
    const { repo,scheduler } = setup(); const token = scheduler.acquireLease("run","owner",3,100);
    const first = scheduler.schedule({ runId:"run",expectedRunRevision:0,ownerId:"owner",fencingToken:token,now:4 })[0]!;
    expect(scheduler.acknowledgeDispatch(event(1,first,"ack",5),"child-1")).toBe(true);
    expect(scheduler.acknowledgeDispatch(event(1,first,"ack",5),"child-1")).toBe(false);
    expect(() => scheduler.reportProgress(event(1,first,"stale",6),1)).toThrow(TaskGraphConflictError);
    expect(scheduler.terminal(event(2,first,"failed",7,"child-1"),"failed",{ reason:"boom" })).toBe(true);
    expect(scheduler.inspect("run",10)[0]).toMatchObject({ready:false,reason:"retry_backoff"});
    const second = scheduler.schedule({ runId:"run",expectedRunRevision:3,ownerId:"owner",fencingToken:token,now:18 })[0]!;
    expect(second.attemptId).not.toBe(first.attemptId); expect(second.generation).toBe(2);
    expect(repo.snapshot("run").attempts).toHaveLength(2);
  });

  it("renews live attempt reservations from accepted progress",()=>{
    const {db,repo,scheduler}=setup();
    const token=scheduler.acquireLease("run","owner",3,100);
    const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",
      fencingToken:token,now:4})[0]!;
    scheduler.acknowledgeDispatch(event(1,attempt,"ack",5,"child"),"child");

    expect(scheduler.reportProgress(event(2,attempt,"progress",900,"child"),1)).toBe(true);
    expect(db.prepare(`SELECT expires_at FROM task_resource_reservations
      WHERE attempt_id=? AND kind='active_attempt'`).get(attempt.attemptId))
      .toEqual({expires_at:1_900});
    expect(scheduler.reportProgress(event(3,attempt,"late",1_901,"child"),2)).toBe(false);
    expect(repo.snapshot("run").attempts[0]).toMatchObject({runtime:"running",progress_seq:1});
  });

  it("does not automatically retry outcomes excluded by the node policy",()=>{
    const terminal=node("a",{retryPolicy:{maxAttempts:3,backoffMs:0,
      retryableOutcomes:["lost"],jitterMs:0}});
    const {repo,scheduler}=setup(spec([terminal]));
    const token=scheduler.acquireLease("run","owner",3,100);
    const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",
      fencingToken:token,now:4})[0]!;
    scheduler.acknowledgeDispatch(event(1,attempt,"ack",5),"child");
    scheduler.terminal(event(2,attempt,"failed",6,"child"),"failed",{reason:"invalid input"});

    expect(repo.snapshot("run").run.status).toBe("failed");
    expect(scheduler.inspect("run",7)[0]).toMatchObject({ready:false,reason:"outcome_not_retryable"});
  });

  it.each(["failed","completed","cancelled"] as const)(
    "keeps an existing %s outcome monotonic under later evidence evaluation",status=>{
      const terminal=node("a",{retryPolicy:{maxAttempts:1,backoffMs:0,
        retryableOutcomes:["lost"],jitterMs:0}});
      const {db,repo,scheduler,evidence}=setup(spec([terminal]));
      const token=scheduler.acquireLease("run","owner",3,100);
      const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",
        fencingToken:token,now:4})[0]!;
      scheduler.acknowledgeDispatch(event(1,attempt,"ack",5),"child");
      scheduler.terminal(event(2,attempt,"done",6,"child"),"succeeded",{summary:"done"});
      db.prepare("UPDATE task_graph_runs SET status=? WHERE id='run'").run(status);

      evidence.evaluate("run",repo.snapshot("run",0).run.revision,7);

      expect(repo.snapshot("run").run.status).toBe(status);
      expect(repo.snapshot("run").attempts[0]).toMatchObject({outcome:"succeeded",
        terminal_witness_json:{summary:"done"}});
    },
  );

  it("satisfies an explicitly skipped dependency after an upstream terminal failure",()=>{
    const upstream=node("a",{failurePolicy:"continue_optional",retryPolicy:{maxAttempts:1,
      backoffMs:0,retryableOutcomes:["lost"],jitterMs:0}});
    const downstream=node("b");
    const edge={id:"a-b",sourceNodeId:"a",targetNodeId:"b",kind:"control" as const,
      sourceOutput:null,targetInput:null,satisfactionPolicy:"all_success" as const,
      failurePolicy:"skip" as const,optional:false};
    const {repo,scheduler,evidence}=setup(spec([upstream,downstream],[edge]));
    const token=scheduler.acquireLease("run","owner",3,100);
    const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",
      fencingToken:token,now:4})[0]!;
    scheduler.acknowledgeDispatch(event(1,attempt,"ack",5),"child");
    scheduler.terminal(event(2,attempt,"failed",6,"child"),"failed",{reason:"optional source failed"});
    evidence.evaluate("run",3,7);

    expect(repo.snapshot("run").edgeEvaluations[0]).toMatchObject({
      edge_id:"a-b",satisfied:1,reason:"upstream_failure_skipped",
    });
    expect(scheduler.inspect("run",8).find(item=>item.nodeId==="b"))
      .toMatchObject({ready:true,reason:"ready"});
  });

  it.each([
    ["all_terminal","fail"],
    ["all_success","skip"],
  ] as const)("keeps %s/%s dependencies fenced while an upstream retry is pending",(
    satisfactionPolicy,failurePolicy,
  )=>{
    const upstream=node("a",{failurePolicy:satisfactionPolicy==="all_terminal"
      ? "satisfy_all_terminal_only" : "continue_optional"});
    const edge={id:"a-b",sourceNodeId:"a",targetNodeId:"b",kind:"control" as const,
      sourceOutput:null,targetInput:null,satisfactionPolicy,failurePolicy,optional:false};
    const {repo,scheduler,evidence}=setup(spec([upstream,node("b")],[edge]));
    const token=scheduler.acquireLease("run","owner",3,100);
    const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",
      fencingToken:token,now:4})[0]!;
    scheduler.acknowledgeDispatch(event(1,attempt,"ack",5),"child");
    scheduler.terminal(event(2,attempt,"failed",6,"child"),"failed",{reason:"retry me"});
    evidence.evaluate("run",3,7);

    expect(repo.snapshot("run").edgeEvaluations[0]).toMatchObject({
      edge_id:"a-b",satisfied:0,reason:"upstream_not_satisfied",
    });
    expect(scheduler.inspect("run",7).find(item=>item.nodeId==="b"))
      .toMatchObject({ready:false,reason:"join_unsatisfied:0/1"});
  });

  it("binds artifacts to hashes and requires an independent verifier", () => {
    const producer = node("producer",{ outputSchemas:{result:{type:"object"}},verificationRequired:true });
    const verifier = node("verifier"); const { repo,scheduler,evidence } = setup(spec([producer,verifier],[],2));
    const token = scheduler.acquireLease("run","owner",3,100);
    const attempts = scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",fencingToken:token,now:4});
    const prod = attempts.find(a=>a.nodeId==="producer")!; const verify = attempts.find(a=>a.nodeId==="verifier")!;
    scheduler.acknowledgeDispatch(event(1,prod,"ack",5),"child");
    evidence.stageArtifact(event(2,prod,"stage",6,"child"),{ id:"artifact",schemaName:"Result",schemaVersion:"1",contentHash:H2,
      storageRef:"artifacts/bb",byteSize:10,classification:"internal",retentionPolicy:"keep",outputName:"result",observedWriteSet:[] });
    scheduler.terminal(event(3,prod,"terminal",7,"child"),"succeeded",{ summary:"done" });
    evidence.commitArtifact(event(4,prod,"commit",8,"child"),"artifact");
    const verification = { id:"verification",runId:"run",nodeId:"producer",producerAttemptId:prod.attemptId,
      verifierAttemptId:verify.attemptId,sourceSnapshotId:"source",artifactHashes:[H2],acceptanceCriteriaVersion:H,
      method:"independent_agent" as const,evidenceRefs:["artifact"],result:"passed" as const,confidence:0.9,at:9 };
    expect(() => evidence.recordVerification({ ...verification,verifierAttemptId:prod.attemptId },5,"self"))
      .toThrow(TaskGraphValidationError);
    expect(evidence.recordVerification(verification,5,"verified")).toBe(true);
    expect(repo.snapshot("run").verifications[0]).toMatchObject({ fingerprint:expect.stringMatching(/^sha256:/),result:"passed" });
  });

  it.each(["failed","succeeded"] as const)(
    "keeps historical artifacts out of readiness when the current producer is %s without output",outcome=>{
      const producer=node("producer",{outputSchemas:{result:{type:"object"}}});
      const consumer=node("consumer",{inputBindings:{result:{type:"object"}}});
      const edge={id:"result",sourceNodeId:"producer",targetNodeId:"consumer",kind:"artifact" as const,
        sourceOutput:"result",targetInput:"result",satisfactionPolicy:"all_success" as const,
        failurePolicy:"skip" as const,optional:false};
      const {db,repo,scheduler,evidence}=setup(spec([producer,consumer],[edge]));
      const token=scheduler.acquireLease("run","owner",3,100);
      const first=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",
        fencingToken:token,now:4})[0]!;
      scheduler.acknowledgeDispatch(event(1,first,"first-ack",5),"first-child");
      evidence.stageArtifact(event(2,first,"first-stage",6,"first-child"),{id:"historical",
        schemaName:"Result",schemaVersion:"1",contentHash:H2,storageRef:"artifacts/historical",
        byteSize:1,classification:"internal",retentionPolicy:"keep",outputName:"result",observedWriteSet:[]});
      scheduler.terminal(event(3,first,"first-terminal",7,"first-child"),"succeeded",{summary:"old"});
      evidence.commitArtifact(event(4,first,"first-commit",8,"first-child"),"historical");
      db.prepare("INSERT INTO task_graph_steering_events VALUES(?,?,?,?,?)")
        .run("steer","run",H,JSON.stringify({instructions:"retry"}),9);
      db.prepare("INSERT INTO task_node_invalidations VALUES(?,?,?,?,?)")
        .run("run","producer","steer",first.attemptId,9);
      evidence.evaluate("run",repo.snapshot("run",0).run.revision,9);
      const second=scheduler.schedule({runId:"run",expectedRunRevision:repo.snapshot("run",0).run.revision,
        ownerId:"owner",fencingToken:token,now:10})[0]!;
      scheduler.acknowledgeDispatch(event(repo.snapshot("run",0).run.revision,second,"second-ack",11),"second-child");
      scheduler.terminal(event(repo.snapshot("run",0).run.revision,second,"second-terminal",12,"second-child"),
        outcome,{summary:"current"});

      evidence.evaluate("run",repo.snapshot("run",0).run.revision,13);

      expect(repo.snapshot("run").edgeEvaluations[0]).toMatchObject({edge_id:"result",satisfied:0});
      expect(scheduler.inspect("run",13).find(item=>item.nodeId==="consumer"))
        .toMatchObject({ready:false,reason:"join_unsatisfied:0/1"});
      expect(repo.snapshot("run").artifacts).toEqual([
        expect.objectContaining({id:"historical",state:"committed",producer_attempt_id:first.attemptId}),
      ]);
    },
  );

  it("recovers crash boundaries repeatably and only replays undelivered outbox rows", () => {
    const { db,repo,scheduler } = setup(); const token = scheduler.acquireLease("run","old",3,5);
    const attempt = scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"old",fencingToken:token,now:4})[0]!;
    const recovery = new TaskGraphRecovery(repo);
    expect(recovery.recover("run","new",10,20).pending).toHaveLength(1);
    expect(recovery.markDelivered(attempt.outboxId,attempt.attemptId,attempt.generation,11)).toBe(true);
    expect(recovery.recover("run","new",2_000,20).pending).toHaveLength(0);
    expect(recovery.recover("run","new",2_001,20).pending).toHaveLength(0);
    expect((db.prepare("SELECT outcome FROM task_node_attempts WHERE id=?").get(attempt.attemptId) as {outcome:string}).outcome).toBe("lost");
    expect((db.prepare("SELECT count(*) n FROM task_scheduler_events WHERE type='attempt_recovered_lost'").get() as {n:number}).n).toBe(1);
  });

  it("honors lost-attempt backoff before admitting a fresh retry identity",()=>{
    const {repo,scheduler}=setup();const token=scheduler.acquireLease("run","old",3,1_000);
    const first=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"old",
      fencingToken:token,now:4})[0]!;
    const recovery=new TaskGraphRecovery(repo);
    recovery.markDelivered(first.outboxId,first.attemptId,first.generation,5);
    const recovered=recovery.recover("run","new",1_010,100);

    expect(recovered.pending).toHaveLength(0);
    expect(repo.snapshot("run").attempts[0]).toMatchObject({runtime:"terminal",outcome:"lost",
      backoff_until:1_020});
    expect(scheduler.inspect("run",1_019)[0]).toMatchObject({ready:false,reason:"retry_backoff"});
    expect(scheduler.schedule({runId:"run",expectedRunRevision:2,ownerId:"new",
      fencingToken:recovered.fencingToken,now:1_019})).toEqual([]);
    const second=scheduler.schedule({runId:"run",expectedRunRevision:2,ownerId:"new",
      fencingToken:recovered.fencingToken,now:1_020})[0]!;
    expect(second).toMatchObject({generation:2});
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(repo.snapshot("run").attempts[1]).toMatchObject({attempt_number:2,generation:2});
  });

  it.each([
    ["fail_graph","failed"],
    ["block_for_decision","blocked"],
  ] as const)("projects recovered non-retryable loss with %s policy as %s",(failurePolicy,status)=>{
    const terminal=node("a",{failurePolicy,retryPolicy:{maxAttempts:3,backoffMs:10,
      retryableOutcomes:["failed"],jitterMs:0}});
    const {repo,scheduler}=setup(spec([terminal]));
    const token=scheduler.acquireLease("run","old",3,1_000);
    const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"old",
      fencingToken:token,now:4})[0]!;
    const recovery=new TaskGraphRecovery(repo);
    recovery.markDelivered(attempt.outboxId,attempt.attemptId,attempt.generation,5);
    recovery.recover("run","new",1_010,100);

    expect(repo.snapshot("run").run.status).toBe(status);
    expect(scheduler.inspect("run",1_010)[0]).toMatchObject({ready:false,reason:"outcome_not_retryable"});
  });

  it.each([
    ["all_terminal","fail","satisfied"],
    ["all_success","skip","upstream_failure_skipped"],
  ] as const)("refreshes %s/%s edges after recovering a lost upstream attempt",(
    satisfactionPolicy,failurePolicy,reason,
  )=>{
    const upstream=node("a",{failurePolicy:satisfactionPolicy==="all_terminal"
      ? "satisfy_all_terminal_only" : "continue_optional",retryPolicy:{maxAttempts:1,
      backoffMs:0,retryableOutcomes:["lost"],jitterMs:0}});
    const edge={id:"a-b",sourceNodeId:"a",targetNodeId:"b",kind:"control" as const,
      sourceOutput:null,targetInput:null,satisfactionPolicy,failurePolicy,optional:false};
    const {repo,scheduler}=setup(spec([upstream,node("b")],[edge]));
    const token=scheduler.acquireLease("run","old",3,1_000);
    const attempt=scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"old",
      fencingToken:token,now:4})[0]!;
    const recovery=new TaskGraphRecovery(repo);
    recovery.markDelivered(attempt.outboxId,attempt.attemptId,attempt.generation,5);
    recovery.recover("run","new",1_010,100);

    expect(repo.snapshot("run").edgeEvaluations[0]).toMatchObject({satisfied:1,reason});
    expect(scheduler.inspect("run",1_010).find(item=>item.nodeId==="b"))
      .toMatchObject({ready:true,reason:"ready"});
  });

  it("enforces bounded expansion", () => {
    const expandable = node("expand",{ expansionPolicy:{maxChildren:2,maxDepth:1} });
    const reducer = node("reduce"); const { repo,evidence } = setup(spec([expandable,reducer]));
    expect(evidence.expand("run","expand",0,[{id:"one",payload:{x:1}},{id:"two",payload:{x:2}}],3)).toBe(1);
    expect(() => evidence.expand("run","expand",1,[{id:"three",payload:{x:3}}],4)).toThrow(TaskGraphValidationError);
    const fingerprint = evidence.reduceExpansion({runId:"run",expansionNodeId:"expand",reducerNodeId:"reduce",
      reductionId:"reduction",expectedRunRevision:1,outputHash:H2,at:5});
    expect(fingerprint).toMatch(/^sha256:/); expect(repo.snapshot("run").reductions).toHaveLength(1);
  });

  it("schedules 1,000 logical nodes with bounded active attempts", () => {
    const nodes = Array.from({length:1_000},(_,i)=>node(`n${String(i).padStart(4,"0")}`));
    const { db,scheduler } = setup(spec(nodes,[],7)); const token = scheduler.acquireLease("run","owner",3,100);
    const admitted = scheduler.schedule({runId:"run",expectedRunRevision:0,ownerId:"owner",fencingToken:token,now:4});
    expect(admitted).toHaveLength(7);
    expect((db.prepare("SELECT count(*) n FROM task_node_attempts WHERE runtime<>'terminal'").get() as {n:number}).n).toBe(7);
    expect(scheduler.inspect("run",4)).toHaveLength(1_000);
  });
});
