import { describe,expect,it,vi } from "vitest";
import { taskGraphResponseEnvelopeSchema } from "../../shared/task-graph-view-contracts.ts";
import { setup } from "../../tests/support/server-command-harness.ts";
import { TaskGraphConflictError } from "../task-graph/errors.ts";
import { dispatchCommand } from "./index.ts";
import { validateWsCommand } from "./schemas.ts";

describe("task-graph command dispatcher",() => {
  it("reads only the current WorkItem iteration's planning projection",async() => {
    const h=setup();
    const snapshot={proposalId:"proposal",revision:3};
    const planning={snapshot:vi.fn(()=>snapshot)};
    h.ctx.taskGraphs={} as never;
    h.ctx.taskGraphPlanning=planning as never;
    h.ctx.workItems={get:vi.fn(async()=>({
      workItem:{currentRunKey:"current-primary"},
    }))} as never;

    dispatchCommand(h.ctx,{type:"get_task_graph_plan",requestId:"request",
      workItemId:"work"},h.ws);

    await vi.waitFor(()=>expect(h.wsSent.length).toBeGreaterThanOrEqual(1));
    expect(planning.snapshot).toHaveBeenCalledWith("work","current-primary");
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",
      type:"task_graph_plan_snapshot",snapshot});
  });

  it("dispatches attempt-bound controls with their concrete attempt identity",async() => {
    const cases=[
      {type:"retry_task_node" as const,method:"retryNode" as const,extra:{}},
      {type:"request_task_verification" as const,method:"requestVerification" as const,extra:{}},
      {type:"waive_task_verification" as const,method:"waiveVerification" as const,
        extra:{actor:"operator",reason:"reviewed"}},
    ];
    for (const entry of cases) {
      const h=setup();
      const invoke=vi.fn(async()=>({}));
      const taskGraphs={assertWorkItem:vi.fn(),[entry.method]:invoke,
        viewSnapshot:vi.fn(()=>({graphRunId:"run",revision:6}))};
      h.ctx.taskGraphs=taskGraphs as never;
      dispatchCommand(h.ctx,{type:entry.type,requestId:`request-${entry.type}`,workItemId:"work",
        runId:"run",nodeId:"node",currentAttemptId:"attempt",expectedRunRevision:5,
        ...entry.extra},h.ws);

      await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
      expect(invoke).toHaveBeenCalledWith({runId:"run",nodeId:"node",currentAttemptId:"attempt",
        expectedRunRevision:5,requestId:`request-${entry.type}`,...entry.extra});
    }
  });

  it("dispatches Leader adjudication with revision and attempt fences",async()=>{
    const h=setup();
    const adjudicateNode=vi.fn(async()=>({}));
    h.ctx.taskGraphs={assertWorkItem:vi.fn(),adjudicateNode,
      viewSnapshot:vi.fn(()=>({graphRunId:"run",revision:6}))} as never;
    dispatchCommand(h.ctx,{type:"adjudicate_task_node",requestId:"adjudicate-1",
      workItemId:"work",runId:"run",nodeId:"verify",currentAttemptId:"attempt",
      expectedRunRevision:5,adjudication:"retry",
      reason:"The verifier omitted the command result.",guidance:"Run the focused suite."},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(adjudicateNode).toHaveBeenCalledWith({runId:"run",nodeId:"verify",
      currentAttemptId:"attempt",expectedRunRevision:5,requestId:"adjudicate-1",
      decision:"retry",actor:"operator:websocket",reason:"The verifier omitted the command result.",
      guidance:"Run the focused suite."});
  });

  it("rejects missing or null attempt identities before dispatch",() => {
    for (const type of ["retry_task_node","request_task_verification","waive_task_verification",
      "adjudicate_task_node"] as const) {
      for (const currentAttemptId of [undefined,null]) {
        const h=setup();
        const assertWorkItem=vi.fn();const retryNode=vi.fn();const requestVerification=vi.fn();
        const waiveVerification=vi.fn();const adjudicateNode=vi.fn();
        h.ctx.taskGraphs={assertWorkItem,retryNode,requestVerification,waiveVerification,
          adjudicateNode} as never;
        const dispatch=vi.fn(dispatchCommand);
        const extra=type==="waive_task_verification"?{actor:"operator",reason:"reviewed"}
          :type==="adjudicate_task_node"
            ? {reason:"reviewed",adjudication:"accepted" as const}:{};
        const validation=validateWsCommand({type,requestId:`request-${type}-${String(currentAttemptId)}`,
          workItemId:"work",runId:"run",nodeId:"node",expectedRunRevision:5,
          ...(currentAttemptId===null?{currentAttemptId}:{}),...extra});

        expect(validation.ok).toBe(false);
        if (!validation.ok) {
          expect(validation.error).toContain(`Invalid "${type}" command:`);
        } else {
          dispatch(h.ctx,validation.cmd,h.ws);
        }
        expect(dispatch).not.toHaveBeenCalled();
        expect(assertWorkItem).not.toHaveBeenCalled();
        expect(retryNode).not.toHaveBeenCalled();
        expect(requestVerification).not.toHaveBeenCalled();
        expect(waiveVerification).not.toHaveBeenCalled();
        expect(adjudicateNode).not.toHaveBeenCalled();
        expect(h.wsSent).toHaveLength(0);
      }
    }
  });

  it("scopes and dispatches graph steering with its mutation fences",async() => {
    const h=setup();
    const snapshot={graphRunId:"run",revision:6};
    const taskGraphs={assertWorkItem:vi.fn(),steer:vi.fn(async()=>({})),
      viewSnapshot:vi.fn(()=>snapshot)};
    h.ctx.taskGraphs=taskGraphs as never;
    dispatchCommand(h.ctx,{type:"steer_task_graph",requestId:"request",workItemId:"work",
      runId:"run",expectedRunRevision:5,instructions:"Prioritize verification",
      affectedNodeIds:["node-a","node-b"]},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(taskGraphs.assertWorkItem).toHaveBeenCalledWith("run","work");
    expect(taskGraphs.steer).toHaveBeenCalledWith({runId:"run",expectedRunRevision:5,
      requestId:"request",instructions:"Prioritize verification",
      affectedNodeIds:["node-a","node-b"]});
    expect(taskGraphs.viewSnapshot).toHaveBeenCalledWith("run");
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",type:"task_graph_response",
      command:"steer_task_graph",requestId:"request",success:true,result:snapshot});
    expect(taskGraphResponseEnvelopeSchema.safeParse(h.wsSent[0]).success).toBe(true);
  });

  it("scopes artifact reads to the owning WorkItem",async() => {
    const h=setup();
    const artifact={id:"artifact",contentHash:`sha256:${"a".repeat(64)}`,byteSize:12};
    const taskGraphs={assertWorkItem:vi.fn(),artifact:vi.fn(()=>artifact)};
    h.ctx.taskGraphs=taskGraphs as never;
    dispatchCommand(h.ctx,{type:"get_task_artifact",requestId:"request",workItemId:"work",
      runId:"run",artifactId:"artifact"},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(taskGraphs.assertWorkItem).toHaveBeenCalledWith("run","work");
    expect(taskGraphs.artifact).toHaveBeenCalledWith({runId:"run",artifactId:"artifact"});
    expect(taskGraphs.assertWorkItem.mock.invocationCallOrder[0])
      .toBeLessThan(taskGraphs.artifact.mock.invocationCallOrder[0]!);
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",type:"task_graph_response",
      command:"get_task_artifact",requestId:"request",success:true,result:artifact});
    expect(taskGraphResponseEnvelopeSchema.safeParse(h.wsSent[0]).success).toBe(true);
  });

  it("returns bounded attempt projections instead of raw persistence rows",async() => {
    const h=setup();
    const attempts=vi.fn(()=>[{id:"attempt",session_run_key:"private-run",
      terminal_witness_json:{finalReport:"private"}}]);
    const projected={id:"attempt",number:1,state:"succeeded",costUsd:0,tokens:0};
    const taskGraphs={assertWorkItem:vi.fn(),attempts,
      viewSnapshot:vi.fn(()=>({nodes:[{id:"node",attemptHistory:[projected]}]}))};
    h.ctx.taskGraphs=taskGraphs as never;
    dispatchCommand(h.ctx,{type:"list_task_graph_attempts",requestId:"request",workItemId:"work",
      runId:"run",nodeId:"node"},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(taskGraphs.assertWorkItem).toHaveBeenCalledWith("run","work");
    expect(taskGraphs.viewSnapshot).toHaveBeenCalledWith("run");
    expect(attempts).not.toHaveBeenCalled();
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",success:true,result:[projected]});
    expect(JSON.stringify(h.wsSent[0])).not.toContain("private");
  });

  it("scopes and dispatches reconciliation with revision, request, and evidence fences",async() => {
    const h=setup();
    const snapshot={graphRunId:"run",revision:9};
    const sourceDiffHash=`sha256:${"b".repeat(64)}`;
    const taskGraphs={assertWorkItem:vi.fn(),reconcile:vi.fn(async()=>({})),
      viewSnapshot:vi.fn(()=>snapshot)};
    h.ctx.taskGraphs=taskGraphs as never;
    dispatchCommand(h.ctx,{type:"reconcile_task_graph_run",requestId:"request",workItemId:"work",
      runId:"run",expectedRunRevision:8,artifactIds:["artifact"],verificationIds:["verification"],
      sourceDiffHash},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(taskGraphs.assertWorkItem).toHaveBeenCalledWith("run","work");
    expect(taskGraphs.reconcile).toHaveBeenCalledWith({runId:"run",expectedRunRevision:8,
      requestId:"request",artifactIds:["artifact"],verificationIds:["verification"],sourceDiffHash});
    expect(taskGraphs.viewSnapshot).toHaveBeenCalledWith("run");
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",type:"task_graph_response",
      command:"reconcile_task_graph_run",requestId:"request",success:true,result:snapshot});
    expect(taskGraphResponseEnvelopeSchema.safeParse(h.wsSent[0]).success).toBe(true);
  });

  it("authorizes a graph snapshot through its WorkItem and emits the typed snapshot envelope",async() => {
    const h=setup();
    const taskGraphs={assertWorkItem:vi.fn(),viewSnapshot:vi.fn(()=>({graphRunId:"run",revision:7}))};
    h.ctx.taskGraphs=taskGraphs as never;
    dispatchCommand(h.ctx,{type:"get_task_graph_snapshot",requestId:"request",workItemId:"work",runId:"run"},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(taskGraphs.assertWorkItem).toHaveBeenCalledWith("run","work");
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",type:"task_graph_snapshot",
      workItemId:"work",runId:"run",revision:7,cause:"command_snapshot"});
  });

  it("defaults graph projection lookup to the current primary WorkItem run",async() => {
    const h=setup();
    const taskGraphs={viewForWorkItem:vi.fn(()=>({graphRunId:"current-graph",revision:7}))};
    h.ctx.taskGraphs=taskGraphs as never;
    h.ctx.workItems={get:vi.fn(async()=>({workItem:{currentRunKey:"current-primary"}}))} as never;

    dispatchCommand(h.ctx,{type:"get_task_graph_snapshot",requestId:"request",
      workItemId:"work"},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(taskGraphs.viewForWorkItem).toHaveBeenCalledWith("work","current-primary");
    expect(h.wsSent[0]).toMatchObject({type:"task_graph_snapshot",runId:"current-graph"});
  });

  it("returns a sanitized typed conflict without leaking repository rows",async() => {
    const h=setup();
    const taskGraphs={assertWorkItem:vi.fn(),pause:vi.fn(async()=>{
      throw new TaskGraphConflictError("stale graph-run revision",{
        id:"run",revision:9,status:"active",source_snapshot_id:"private-source",
      });
    })};
    h.ctx.taskGraphs=taskGraphs as never;
    dispatchCommand(h.ctx,{type:"pause_task_graph_run",requestId:"request",workItemId:"work",
      runId:"run",expectedRunRevision:8},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",type:"task_graph_response",
      command:"pause_task_graph_run",requestId:"request",success:false,code:"conflict",
      error:"stale graph-run revision",latest:{runId:"run",revision:9,status:"active"}});
    expect((h.wsSent[0]!["latest"] as Record<string,unknown>)["source_snapshot_id"]).toBeUndefined();
    expect(taskGraphResponseEnvelopeSchema.safeParse(h.wsSent[0]).success).toBe(true);
  });

  it("rejects graph revision ownership mismatches before persistence",async() => {
    const h=setup();const createRevision=vi.fn();
    h.ctx.taskGraphs={createRevision} as never;
    dispatchCommand(h.ctx,{type:"create_task_graph_revision",requestId:"request",workItemId:"work",
      graphRevision:{workItemId:"foreign"} as never},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(createRevision).not.toHaveBeenCalled();
    expect(h.wsSent[0]).toMatchObject({success:false,code:"validation_failed",
      error:"graph revision ownership mismatch"});
  });

  it("rejects graph revisions outside the canonical WorkItem workspace",async() => {
    const h=setup();const createRevision=vi.fn();const get=vi.fn(async()=>({
      workItem:{id:"work",projectId:"workspace-a"},
    }));
    h.ctx.taskGraphs={createRevision} as never;
    h.ctx.workItems={get} as never;
    h.ctx.resolveWorkItemWorkspace=vi.fn(()=>({projectId:"workspace-b",projectPath:"/repo-b"}));
    dispatchCommand(h.ctx,{type:"create_task_graph_revision",requestId:"request",workItemId:"work",
      graphRevision:{workItemId:"work",workspaceId:"workspace-b"} as never},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(get).toHaveBeenCalledWith("work");
    expect(createRevision).not.toHaveBeenCalled();
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",success:false,
      code:"validation_failed",error:"graph workspace does not match canonical WorkItem"});
  });

  it("rejects run starts outside the canonical WorkItem workspace",async() => {
    const h=setup();const startRun=vi.fn();
    h.ctx.taskGraphs={startRun} as never;
    h.ctx.workItems={get:vi.fn(async()=>({workItem:{id:"work",projectId:"workspace-a"}}))} as never;
    h.ctx.resolveWorkItemWorkspace=vi.fn(()=>({projectId:"workspace-b",projectPath:"/repo-b"}));
    dispatchCommand(h.ctx,{type:"start_task_graph_run",requestId:"request",workItemId:"work",
      runId:"run",primaryRunKey:"primary",revisionId:"revision",expectedLifecycleRevision:3,
      sourceSnapshot:{workspaceId:"workspace-b"} as never},h.ws);

    await vi.waitFor(()=>expect(h.wsSent).toHaveLength(1));
    expect(startRun).not.toHaveBeenCalled();
    expect(h.wsSent[0]).toMatchObject({topic:"work-item:work",success:false,
      code:"validation_failed",error:"graph workspace does not match canonical WorkItem"});
  });
});
