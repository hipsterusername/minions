import type {
  TaskGraphPlanHistoryEntry,
  TaskGraphPlanSnapshotView,
} from "../../shared/task-graph-planning-contracts.ts";
import type {TaskGraphSnapshotView} from "../../shared/task-graph-view-contracts.ts";
import {TaskGraphConflictError,TaskGraphValidationError} from "./errors.ts";
import {readPlanningArtifact} from "./planning-artifact.ts";
import type {TaskGraphPlanningRepository} from "./planning-repository.ts";
import type {TaskGraphService} from "./service.ts";

export interface PlanningHistorySelector {
  proposalId?:string;
  graphRunId?:string;
  historyLimit?:number;
}

export interface PlanningInspection {
  plan:TaskGraphPlanSnapshotView|null;
  runtime:TaskGraphSnapshotView|null;
  history:TaskGraphPlanHistoryEntry[];
}

export function inspectPlanningHistory(
  repo:TaskGraphPlanningRepository,
  taskGraphs:TaskGraphService,
  workItemId:string,
  primaryRunKey:string,
  selector:PlanningHistorySelector={},
):PlanningInspection {
  repo.assertAuthority(workItemId,primaryRunKey);
  const plan=selectedPlan(repo,workItemId,primaryRunKey,selector);
  return {
    plan,
    runtime:plan?.graphRunId?taskGraphs.viewSnapshot(plan.graphRunId):null,
    history:repo.history(workItemId,primaryRunKey,selector.historyLimit??20),
  };
}

export function readPlanningHistoryArtifact(
  repo:TaskGraphPlanningRepository,
  input:{workItemId:string;primaryRunKey:string;graphRunId?:string;
    artifactId:string;offset:number;maxBytes:number},
):Record<string,unknown> {
  repo.assertAuthority(input.workItemId,input.primaryRunKey);
  const plan=input.graphRunId
    ? repo.proposalForRun(input.graphRunId)
    : repo.latest(input.workItemId,input.primaryRunKey);
  assertPlanAuthority(plan,input.workItemId,input.primaryRunKey);
  return readPlanningArtifact(repo.db,plan,input);
}

export async function cancelPlanningGraphRun(
  repo:TaskGraphPlanningRepository,
  taskGraphs:TaskGraphService,
  input:{workItemId:string;primaryRunKey:string;runId:string;
    expectedRunRevision:number;requestId:string},
  reflect:(runId:string,status:string,revision:number)=>void,
):Promise<TaskGraphPlanSnapshotView> {
  repo.assertAuthority(input.workItemId,input.primaryRunKey);
  const plan=repo.proposalForRun(input.runId);
  assertPlanAuthority(plan,input.workItemId,input.primaryRunKey);
  const graph=await taskGraphs.cancel(input.runId,input.expectedRunRevision,input.requestId);
  reflect(graph.run.id,graph.run.status,graph.run.revision);
  return repo.get(plan.proposalId);
}

export function synchronizeLatestPlanningRuntime(
  repo:TaskGraphPlanningRepository,
  taskGraphs:TaskGraphService,
  workItemId:string,
  primaryRunKey:string,
  reflect:(runId:string,status:string,revision:number)=>void,
):void {
  const latest=repo.latest(workItemId,primaryRunKey);
  if (!latest?.graphRunId) return;
  try {
    const graph=taskGraphs.snapshot(latest.graphRunId);
    reflect(graph.run.id,graph.run.status,graph.run.revision);
  } catch (error) {
    if (latest.state!=="failed") throw error;
  }
}

function selectedPlan(
  repo:TaskGraphPlanningRepository,
  workItemId:string,
  primaryRunKey:string,
  selector:PlanningHistorySelector,
):TaskGraphPlanSnapshotView|null {
  const plan=selector.proposalId?repo.get(selector.proposalId)
    :selector.graphRunId?repo.proposalForRun(selector.graphRunId)
      :repo.latest(workItemId,primaryRunKey);
  if ((selector.proposalId || selector.graphRunId) && !plan) {
    throw new TaskGraphValidationError("graph-plan history entry not found");
  }
  if (plan) assertPlanAuthority(plan,workItemId,primaryRunKey);
  return plan;
}

function assertPlanAuthority(
  plan:TaskGraphPlanSnapshotView|null,
  workItemId:string,
  primaryRunKey:string,
):asserts plan is TaskGraphPlanSnapshotView {
  if (!plan) throw new TaskGraphValidationError("graph plan not found");
  if (plan.workItemId!==workItemId || plan.primaryRunKey!==primaryRunKey) {
    throw new TaskGraphConflictError("graph plan is outside the current Leader authority");
  }
}
