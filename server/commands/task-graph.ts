import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { unicastGlobal, unicastToWorkItem } from "../bus.ts";
import { serverLogger } from "../logging.ts";
import { TaskGraphConflictError, TaskGraphValidationError } from "../task-graph/errors.ts";
import type { CommandContext, CommandHandler, WsCommand } from "./types.ts";

const log = serverLogger.child("task-graph-command");

type TaskGraphControlService = NonNullable<Parameters<CommandHandler>[0]["taskGraphs"]> & {
  steer(input:{runId:string;expectedRunRevision:number;requestId:string;
    instructions:string;affectedNodeIds:string[]}): Promise<unknown>;
  artifact(input:{runId:string;artifactId:string}): unknown;
  reconcile(input:{runId:string;expectedRunRevision:number;requestId:string;
    artifactIds:string[];verificationIds:string[];sourceDiffHash:string}): Promise<unknown>;
};

function send(ws: Parameters<CommandHandler>[2], cmd: WsCommand, payload: Record<string, unknown>): void {
  if (cmd.workItemId) unicastToWorkItem(ws,cmd.workItemId,payload as {type:string}&Record<string,unknown>);
  else unicastGlobal(ws,payload as {type:string}&Record<string,unknown>);
}

function reply(ws: Parameters<CommandHandler>[2], cmd: WsCommand, result: unknown): void {
  send(ws,cmd,{ type:"task_graph_response",command:cmd.type,requestId:cmd.requestId ?? null,
    success:true,result });
}

function snapshotReply(ws: Parameters<CommandHandler>[2], cmd: WsCommand,
  snapshot: import("../../shared/task-graph-view-contracts.ts").TaskGraphSnapshotView | null): void {
  if (!snapshot) { reply(ws,cmd,null); return; }
  unicastToWorkItem(ws,cmd.workItemId!,{ type:"task_graph_snapshot",workItemId:cmd.workItemId!,
    runId:snapshot.graphRunId,revision:snapshot.revision,cause:"command_snapshot",snapshot,timestamp:Date.now() });
}

function planSnapshotReply(ws: Parameters<CommandHandler>[2], cmd: WsCommand,
  snapshot: import("../../shared/task-graph-planning-contracts.ts").TaskGraphPlanSnapshotView | null): void {
  unicastToWorkItem(ws,cmd.workItemId!,{ type:"task_graph_plan_snapshot",
    workItemId:cmd.workItemId!,revision:snapshot?.revision ?? 0,
    snapshot,timestamp:Date.now() });
}

function fail(ws: Parameters<CommandHandler>[2], cmd: WsCommand, error: unknown): void {
  const correlationId = randomUUID();
  const code = error instanceof TaskGraphConflictError ? "conflict"
    : error instanceof TaskGraphValidationError || error instanceof z.ZodError ? "validation_failed"
    : "internal";
  const message = code === "internal" ? "Task-graph command failed"
    : error instanceof Error ? error.message : "Task-graph command failed";
  const latest = error instanceof TaskGraphConflictError ? conflictHint(error.latest) : null;
  log.error("command_failed",{ correlationId,command:cmd.type,requestId:cmd.requestId ?? null,
    workItemId:cmd.workItemId ?? null,runId:cmd.runId ?? null,code,error });
  send(ws,cmd,{ type:"task_graph_response",command:cmd.type,requestId:cmd.requestId ?? null,
    success:false,code,error:message,latest,correlationId });
}

async function assertCanonicalWorkItemScope(
  ctx: CommandContext,
  workItemId: string,
  workspaceId: string,
): Promise<void> {
  if (!ctx.workItems) throw new TaskGraphValidationError("canonical WorkItem service is unavailable");
  const workspace=ctx.resolveWorkItemWorkspace?.(workspaceId);
  if (ctx.resolveWorkItemWorkspace && !workspace) {
    throw new TaskGraphValidationError("graph workspace is not registered");
  }
  const detail=await ctx.workItems.get(workItemId);
  if (!detail) throw new TaskGraphValidationError("WorkItem not found");
  if (detail.workItem.projectId !== (workspace?.projectId ?? workspaceId)) {
    throw new TaskGraphValidationError("graph workspace does not match canonical WorkItem");
  }
}

export const taskGraphCommand: CommandHandler = async (ctx,cmd,ws) => {
  const service = ctx.taskGraphs as TaskGraphControlService | undefined;
  if (!service) {
    send(ws,cmd,{ type:"task_graph_response",command:cmd.type,requestId:cmd.requestId ?? null,
      success:false,code:"unavailable",error:"Task-graph service is unavailable",latest:null });
    return;
  }
  try {
    let result: unknown;
    let directSnapshot: import("../../shared/task-graph-view-contracts.ts").TaskGraphSnapshotView | null | undefined;
    switch (cmd.type) {
      case "get_task_graph_plan": {
        const detail=await ctx.workItems?.get(cmd.workItemId!);
        const currentRunKey=detail?.workItem.currentRunKey ?? null;
        const snapshot=currentRunKey
          ? ctx.taskGraphPlanning?.snapshot(cmd.workItemId!,currentRunKey) ?? null : null;
        planSnapshotReply(ws,cmd,snapshot); result=snapshot; break;
      }
      case "approve_task_graph_plan":
        if (!ctx.taskGraphPlanning) throw new TaskGraphValidationError("graph planning is unavailable");
        result=await ctx.taskGraphPlanning.approve({workItemId:cmd.workItemId!,
          proposalId:cmd.proposalId!,expectedProposalRevision:cmd.expectedProposalRevision!}); break;
      case "reject_task_graph_plan":
        if (!ctx.taskGraphPlanning) throw new TaskGraphValidationError("graph planning is unavailable");
        result=ctx.taskGraphPlanning.reject({workItemId:cmd.workItemId!,
          proposalId:cmd.proposalId!,expectedProposalRevision:cmd.expectedProposalRevision!}); break;
      case "validate_task_graph_revision":
        result = service.validateRevision(cmd.graphRevision); break;
      case "create_task_graph_revision": {
        const revision=cmd.graphRevision;
        if (!revision || revision.workItemId !== cmd.workItemId) throw new TaskGraphValidationError("graph revision ownership mismatch");
        await assertCanonicalWorkItemScope(ctx,cmd.workItemId!,revision.workspaceId);
        result = service.createRevision(revision,undefined,cmd.requestId!); break;
      }
      case "start_task_graph_run":
        await assertCanonicalWorkItemScope(ctx,cmd.workItemId!,cmd.sourceSnapshot!.workspaceId);
        result = await service.startRun({ id:cmd.runId!,workItemId:cmd.workItemId!,
          primaryRunKey:cmd.primaryRunKey!,revisionId:cmd.revisionId!,sourceSnapshot:cmd.sourceSnapshot!,
          expectedLifecycleRevision:cmd.expectedLifecycleRevision!,requestId:cmd.requestId! });
        result = service.viewSnapshot(cmd.runId!); break;
      case "get_task_graph_snapshot":
        if (cmd.runId) service.assertWorkItem(cmd.runId,cmd.workItemId!);
        if (cmd.runId) directSnapshot = service.viewSnapshot(cmd.runId);
        else {
          const detail = cmd.primaryRunKey ? null : await ctx.workItems?.get(cmd.workItemId!);
          const primaryRunKey = cmd.primaryRunKey ?? detail?.workItem.currentRunKey ?? null;
          directSnapshot = primaryRunKey
            ? service.viewForWorkItem(cmd.workItemId!,primaryRunKey) : null;
        }
        result = directSnapshot; break;
      case "pause_task_graph_run":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.pause(cmd.runId!,cmd.expectedRunRevision!,true,cmd.requestId!);
        result = service.viewSnapshot(cmd.runId!); break;
      case "resume_task_graph_run":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.pause(cmd.runId!,cmd.expectedRunRevision!,false,cmd.requestId!);
        result = service.viewSnapshot(cmd.runId!); break;
      case "cancel_task_graph_run":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.cancel(cmd.runId!,cmd.expectedRunRevision!,cmd.requestId!);
        result = service.viewSnapshot(cmd.runId!); break;
      case "retry_task_node":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.retryNode({ runId:cmd.runId!,nodeId:cmd.nodeId!,
          expectedRunRevision:cmd.expectedRunRevision!,currentAttemptId:cmd.currentAttemptId!,
          requestId:cmd.requestId! });
        result = service.viewSnapshot(cmd.runId!); break;
      case "cancel_task_attempt":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.cancelAttempt({ runId:cmd.runId!,nodeId:cmd.nodeId!,
          currentAttemptId:cmd.currentAttemptId!,expectedRunRevision:cmd.expectedRunRevision!,
          requestId:cmd.requestId! });
        result = service.viewSnapshot(cmd.runId!); break;
      case "request_task_verification":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.requestVerification({ runId:cmd.runId!,nodeId:cmd.nodeId!,
          currentAttemptId:cmd.currentAttemptId!,expectedRunRevision:cmd.expectedRunRevision!,
          requestId:cmd.requestId! });
        result = service.viewSnapshot(cmd.runId!); break;
      case "waive_task_verification":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.waiveVerification({ runId:cmd.runId!,nodeId:cmd.nodeId!,
          currentAttemptId:cmd.currentAttemptId!,expectedRunRevision:cmd.expectedRunRevision!,
          actor:cmd.actor!,reason:cmd.reason!,requestId:cmd.requestId! });
        result = service.viewSnapshot(cmd.runId!); break;
      case "provide_task_input":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.provideInput({ runId:cmd.runId!,nodeId:cmd.nodeId!,
          expectedRunRevision:cmd.expectedRunRevision!,actor:cmd.actor!,value:cmd.input!,
          requestId:cmd.requestId! });
        result = service.viewSnapshot(cmd.runId!); break;
      case "list_task_graph_attempts":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        result = service.viewSnapshot(cmd.runId!).nodes
          .filter(node=>!cmd.nodeId || node.id===cmd.nodeId)
          .flatMap(node=>node.attemptHistory); break;
      case "steer_task_graph":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.steer({ runId:cmd.runId!,expectedRunRevision:cmd.expectedRunRevision!,
          requestId:cmd.requestId!,instructions:cmd.instructions!,affectedNodeIds:cmd.affectedNodeIds! });
        result = service.viewSnapshot(cmd.runId!); break;
      case "get_task_artifact":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        result = service.artifact({ runId:cmd.runId!,artifactId:cmd.artifactId! }); break;
      case "reconcile_task_graph_run":
        service.assertWorkItem(cmd.runId!,cmd.workItemId!);
        await service.reconcile({ runId:cmd.runId!,expectedRunRevision:cmd.expectedRunRevision!,
          requestId:cmd.requestId!,artifactIds:cmd.artifactIds!,verificationIds:cmd.verificationIds!,
          sourceDiffHash:cmd.sourceDiffHash! });
        result = service.viewSnapshot(cmd.runId!); break;
      default: throw new TaskGraphValidationError("unsupported task-graph command");
    }
    if (directSnapshot !== undefined) snapshotReply(ws,cmd,directSnapshot);
    else reply(ws,cmd,result);
  } catch (error) { fail(ws,cmd,error); }
};

function conflictHint(latest:unknown): Record<string,unknown>|null {
  if (!latest || typeof latest !== "object") return null;
  const row=latest as Record<string,unknown>;
  const run=(row["run"] && typeof row["run"] === "object" ? row["run"] : row) as Record<string,unknown>;
  const runId=run["id"] ?? run["run_id"];
  const revision=run["revision"];
  const status=run["status"];
  return { ...(typeof runId === "string" ? {runId} : {}),
    ...(typeof revision === "number" ? {revision} : {}),
    ...(typeof status === "string" ? {status} : {}) };
}
