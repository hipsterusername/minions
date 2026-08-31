import type Database from "better-sqlite3";
import type { Bus } from "../bus.ts";
import type { TaskGraphPlanSnapshotView } from "../../shared/task-graph-planning-contracts.ts";
import { getSessionCanvasContext } from "../canvas-context-store.ts";
import { getHarness } from "../harness/index.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionHostDeps } from "../session-host-types.ts";
import { requestWaitResume } from "../wait-resume.ts";
import { findWorkspaceBySource } from "../workspace-registry.ts";
import { minionSkillMcpToolNames } from "../agents/minion-tool-policy.ts";
import { TaskGraphPlanningCoordinator } from "./planning-coordinator.ts";
import { leaderOrchestrationModeForRun, planningContextForRun } from "./planning-mode.ts";
import type { TaskGraphService } from "./service.ts";

export function installTaskGraphPlanningRuntime(input: {
  db: Database.Database;
  bus: Bus;
  registry: SessionRegistry;
  sessionDeps: SessionHostDeps;
  taskGraphs: TaskGraphService;
}): TaskGraphPlanningCoordinator {
  let coordinator: TaskGraphPlanningCoordinator;
  const terminalWakePending = new Set<string>();
  coordinator = new TaskGraphPlanningCoordinator({
    db: input.db,
    bus: input.bus,
    taskGraphs: input.taskGraphs,
    resolveSourceAuthority: (workItemId, primaryRunKey) => {
      const host = input.registry.get(primaryRunKey);
      if (!host || host.workItemId !== workItemId || host.runKind !== "primary") return null;
      const projectPath = host.worktree?.projectPath ?? host.cwd;
      const workspace = findWorkspaceBySource(projectPath);
      if (!workspace) return null;
      return {
        workspaceId: workspace.id,
        cwd: host.cwd,
        projectPath,
        worktreeIdentity: host.worktree
          ? `${host.worktree.branch}:${host.worktree.path}` : `workspace:${workspace.id}`,
        connectedContext: getSessionCanvasContext(primaryRunKey)
          ?? planningContextForRun(input.db, primaryRunKey),
        skillIds: host.skillIds,
        skillValues: host.skillValues,
        harnessName: host.harnessName,
        allowedTools: host.toolAllowlist ?? [
          ...getHarness(host.harnessName).builtInTools,
          ...minionSkillMcpToolNames(host.skillIds),
        ],
      };
    },
    onTerminal: (plan) => {
      const host = input.registry.get(plan.primaryRunKey);
      if (!host) return;
      const wakeId = plan.graphRunId ?? plan.proposalId;
      if (terminalWakePending.has(wakeId)) return;
      terminalWakePending.add(wakeId);
      requestWaitResume(host, input.sessionDeps, {
        immediate: true,
        idempotencyKey: `graph-terminal:${wakeId}:${plan.state}`,
        completedReason: `Execution graph ${plan.state}`,
        onDelivered: () => {
          if (plan.graphRunId) coordinator.acknowledgeTerminalWake(
            plan.proposalId, plan.graphRunId,
          );
          terminalWakePending.delete(wakeId);
        },
        opts: {
          sessionKey: host.id,
          invocationKind: "resume_open_run",
          prompt: `The execution graph is now ${plan.state}. Call get_graph_plan, inspect the canonical runtime and evidence, then synthesize the final response.`,
          cwd: host.cwd,
          resumeId: host.sessionId ?? undefined,
          harness: host.harnessName,
          role: host.role,
        },
      });
    },
    onAttention: (plan, _reason, runRevision) => {
      const host = input.registry.get(plan.primaryRunKey);
      if (!host) return;
      const prompt=attentionPrompt(coordinator,input.taskGraphs,plan,runRevision);
      requestWaitResume(host, input.sessionDeps, {
        immediate: true,
        idempotencyKey: `graph-attention:${plan.graphRunId ?? plan.proposalId}:${runRevision}`,
        completedReason: "Execution graph needs attention",
        opts: {
          sessionKey: host.id,
          invocationKind: "resume_open_run",
          prompt,
          cwd: host.cwd,
          resumeId: host.sessionId ?? undefined,
          harness: host.harnessName,
          role: host.role,
        },
      });
    },
  });
  input.sessionDeps.getLeaderOrchestrationMode = (runKey) =>
    leaderOrchestrationModeForRun(input.db, runKey);
  input.sessionDeps.getTaskGraphPlanning = (runKey) =>
    leaderOrchestrationModeForRun(input.db, runKey) === "direct" ? null : coordinator;
  return coordinator;
}

function attentionPrompt(
  coordinator:TaskGraphPlanningCoordinator,
  taskGraphs:TaskGraphService,
  plan:TaskGraphPlanSnapshotView,
  runRevision:number,
):string {
  if (!plan.graphRunId) return genericAttentionPrompt;
  try {
    const graph=taskGraphs.snapshot(plan.graphRunId);
    const satisfied=new Set(graph.edgeEvaluations.filter(row=>Boolean(row["satisfied"]))
      .map(row=>String(row["edge_id"])));
    const gate=graph.revision.edges.find(edge=>edge.kind==="human_gate"
      &&!satisfied.has(edge.id)&&graph.revision.nodes.some(node=>node.id===edge.sourceNodeId
        &&node.reasoning?.kind==="dialectic"&&node.reasoning.phase==="synthesis"
        &&!node.reasoning.final));
    if (!gate) return genericAttentionPrompt;
    const artifact=graph.artifacts.find(row=>row["node_id"]===gate.sourceNodeId
      &&row["output_name"]==="synthesis"&&row["state"]==="committed");
    const report=artifact?coordinator.readArtifact({workItemId:plan.workItemId,
      primaryRunKey:plan.primaryRunKey,graphRunId:plan.graphRunId,
      artifactId:String(artifact["id"]),offset:0,maxBytes:16_384})["content"]:null;
    return [
      "A dialectic synthesis checkpoint is ready for Leader moderation.",
      `Checkpoint node: ${gate.sourceNodeId}. Expected graph revision: ${graph.run.revision||runRevision}.`,
      typeof report==="string"?`Synthesis report:\n${report}`:
        "Call get_graph_plan and read_graph_artifact to inspect the synthesis report.",
      "Evaluate goal distance and unresolved questions, then call moderate_dialectic to continue, reshape, or stop.",
    ].join("\n\n");
  } catch {
    return genericAttentionPrompt;
  }
}

const genericAttentionPrompt="The execution graph is blocked. Call get_graph_plan, inspect the canonical blocker and evidence, then resolve it or ask the user one focused question.";
