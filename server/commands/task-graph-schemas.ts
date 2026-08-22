import { z } from "zod/v4";
import { graphRevisionInputSchema,hashSchema,sourceSnapshotSchema } from "../../shared/task-graph-contracts.ts";

const requiredId=z.string().min(1);
const revision=z.number().int().nonnegative();
const command=<T extends string>(type:T,fields:z.ZodRawShape)=>
  z.object({type:z.literal(type),requestId:requiredId,...fields});

/** Inbound graph commands stay isolated so the global command gate remains reviewable. */
export const TASK_GRAPH_COMMAND_SCHEMAS={
  get_task_graph_plan:command("get_task_graph_plan",{workItemId:requiredId}),
  approve_task_graph_plan:command("approve_task_graph_plan",{
    workItemId:requiredId,proposalId:requiredId,expectedProposalRevision:revision,
  }),
  reject_task_graph_plan:command("reject_task_graph_plan",{
    workItemId:requiredId,proposalId:requiredId,expectedProposalRevision:revision,
  }),
  validate_task_graph_revision:command("validate_task_graph_revision",{graphRevision:graphRevisionInputSchema}),
  create_task_graph_revision:command("create_task_graph_revision",{
    workItemId:requiredId,graphRevision:graphRevisionInputSchema,
  }),
  start_task_graph_run:command("start_task_graph_run",{
    runId:requiredId,workItemId:requiredId,primaryRunKey:requiredId,revisionId:requiredId,
    sourceSnapshot:sourceSnapshotSchema,expectedLifecycleRevision:revision,
  }),
  get_task_graph_snapshot:command("get_task_graph_snapshot",{
    workItemId:requiredId,runId:requiredId.optional(),primaryRunKey:requiredId.optional(),
  }).refine(value=>{
    const selector=value as typeof value & {runId?:string;primaryRunKey?:string};
    return !(selector.runId && selector.primaryRunKey);
  },{
    message:"runId and primaryRunKey are mutually exclusive",
  }),
  pause_task_graph_run:command("pause_task_graph_run",{
    workItemId:requiredId,runId:requiredId,expectedRunRevision:revision,
  }),
  resume_task_graph_run:command("resume_task_graph_run",{
    workItemId:requiredId,runId:requiredId,expectedRunRevision:revision,
  }),
  cancel_task_graph_run:command("cancel_task_graph_run",{
    workItemId:requiredId,runId:requiredId,expectedRunRevision:revision,
  }),
  retry_task_node:command("retry_task_node",{
    workItemId:requiredId,runId:requiredId,nodeId:requiredId,expectedRunRevision:revision,
    currentAttemptId:requiredId,
  }),
  cancel_task_attempt:command("cancel_task_attempt",{
    workItemId:requiredId,runId:requiredId,nodeId:requiredId,
    currentAttemptId:requiredId,expectedRunRevision:revision,
  }),
  request_task_verification:command("request_task_verification",{
    workItemId:requiredId,runId:requiredId,nodeId:requiredId,
    currentAttemptId:requiredId,expectedRunRevision:revision,
  }),
  waive_task_verification:command("waive_task_verification",{
    workItemId:requiredId,runId:requiredId,nodeId:requiredId,currentAttemptId:requiredId,
    expectedRunRevision:revision,actor:requiredId,reason:requiredId,
  }),
  adjudicate_task_node:command("adjudicate_task_node",{
    workItemId:requiredId,runId:requiredId,nodeId:requiredId,currentAttemptId:requiredId,
    expectedRunRevision:revision,adjudication:z.enum(["accepted","rejected","retry"]),
    reason:z.string().trim().min(1).max(2_000),
    guidance:z.string().trim().min(1).max(4_000).optional(),
  }).strict().superRefine((value,ctx)=>{
    const adjudication=value as typeof value & {
      adjudication:"accepted"|"rejected"|"retry";guidance?:string;
    };
    if (adjudication.guidance && adjudication.adjudication!=="retry") {
      ctx.addIssue({code:"custom",path:["guidance"],message:"guidance is only valid for retry"});
    }
  }),
  provide_task_input:command("provide_task_input",{
    workItemId:requiredId,runId:requiredId,nodeId:requiredId,currentAttemptId:requiredId.nullable(),
    expectedRunRevision:revision,actor:requiredId,input:z.string().trim().min(1),
  }),
  list_task_graph_attempts:command("list_task_graph_attempts",{
    workItemId:requiredId,runId:requiredId,nodeId:requiredId.optional(),
  }),
  steer_task_graph:command("steer_task_graph",{
    workItemId:requiredId,runId:requiredId,expectedRunRevision:revision,
    instructions:z.string().trim().min(1),affectedNodeIds:z.array(requiredId).min(1),
  }),
  get_task_artifact:command("get_task_artifact",{
    workItemId:requiredId,runId:requiredId,artifactId:requiredId,
  }),
  reconcile_task_graph_run:command("reconcile_task_graph_run",{
    workItemId:requiredId,runId:requiredId,expectedRunRevision:revision,
    artifactIds:z.array(requiredId).min(1),verificationIds:z.array(requiredId),sourceDiffHash:hashSchema,
  }),
} as const;
