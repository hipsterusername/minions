import { describe,expect,it } from "vitest";
import {
  getTaskGraphViewSnapshotCommandSchema,
  taskGraphResponseEnvelopeSchema,
  taskGraphViewControlCommandSchema,
} from "./task-graph-view-contracts.ts";

describe("task graph response envelope",() => {
  it("accepts typed success and failure responses",() => {
    expect(taskGraphResponseEnvelopeSchema.parse({topic:"work-item:work",type:"task_graph_response",
      command:"pause_task_graph_run",requestId:"request",success:true,result:{revision:2}}))
      .toMatchObject({success:true});
    expect(taskGraphResponseEnvelopeSchema.parse({topic:"work-item:work",type:"task_graph_response",
      command:"pause_task_graph_run",requestId:"request",success:false,code:"conflict",
      error:"stale graph-run revision",latest:{runId:"run",revision:3}}))
      .toMatchObject({success:false,code:"conflict"});
  });

  it("rejects ambiguous or untyped failures",() => {
    expect(taskGraphResponseEnvelopeSchema.safeParse({topic:"work-item:work",type:"task_graph_response",
      command:"pause_task_graph_run",requestId:"request",success:false,error:"failed",latest:null}).success)
      .toBe(false);
    expect(taskGraphResponseEnvelopeSchema.safeParse({topic:"work-item:work",type:"task_graph_response",
      command:"pause_task_graph_run",requestId:"request",success:"yes",result:null}).success)
      .toBe(false);
  });
});

describe("task graph view commands",() => {
  it("requires a concrete displayed attempt fence for attempt-bound controls",() => {
    for (const type of ["retry_task_node","request_task_verification","waive_task_verification"] as const) {
      const extra=type==="waive_task_verification"?{actor:"operator",reason:"reviewed"}:{};
      const command={type,requestId:"request",workItemId:"work",runId:"run",nodeId:"node",
        expectedRunRevision:2,...extra};
      expect(taskGraphViewControlCommandSchema.safeParse(command).success).toBe(false);
      expect(taskGraphViewControlCommandSchema.safeParse({...command,currentAttemptId:null}).success).toBe(false);
      expect(taskGraphViewControlCommandSchema.safeParse({...command,currentAttemptId:"attempt"}).success).toBe(true);
    }
  });

  it("keeps pre-attempt human input explicitly nullable",() => {
    expect(taskGraphViewControlCommandSchema.safeParse({type:"provide_task_input",requestId:"request",
      workItemId:"work",runId:"run",nodeId:"node",currentAttemptId:null,expectedRunRevision:2,
      actor:"operator",input:"Proceed"}).success).toBe(true);
  });

  it("supports one unambiguous snapshot selector",() => {
    expect(getTaskGraphViewSnapshotCommandSchema.safeParse({type:"get_task_graph_snapshot",
      requestId:"request",workItemId:"work",primaryRunKey:"primary"}).success).toBe(true);
    expect(getTaskGraphViewSnapshotCommandSchema.safeParse({type:"get_task_graph_snapshot",
      requestId:"request",workItemId:"work",runId:"run",primaryRunKey:"primary"}).success)
      .toBe(false);
  });
});
