import { GraphInspector } from "./GraphInspector.tsx";
import { GraphSummaryCard } from "./GraphSummaryCard.tsx";
import { GraphPlanProposalCard, GraphPlanProposalDialog } from "./GraphPlanProposal.tsx";
import type { LeaderTaskGraphController } from "./use-leader-task-graph-controller.ts";
import type { GraphPlanItem } from "./types.ts";

export interface LeaderTaskGraphBridgeProps {
  controller: LeaderTaskGraphController;
  goal?: string | null;
  plan?: readonly GraphPlanItem[];
  onAdjust?: (() => void) | undefined;
}

/** Ephemeral graph surface: deliberately keeps the large snapshot out of LeaderData. */
export function LeaderTaskGraphBridge({
  controller, goal, plan = [], onAdjust,
}: LeaderTaskGraphBridgeProps) {
  const { snapshot, planSnapshot, controlsEnabled, planControlsEnabled, stale,
    sendAction, approvePlan, rejectPlan, open, openInspector, closeInspector } = controller;
  if (!snapshot && !planSnapshot) return null;
  const displayedPlan: readonly GraphPlanItem[] = plan.length ? plan
    : planSnapshot?.steps.map((step) => ({
      taskId: step.nodeId ?? step.key,
      title: step.title,
      description: step.objective,
      status: runtimePlanStatus(snapshot?.nodes.find((node) => node.id === step.nodeId)),
      executor: "minion" as const,
      minionSessionKey: null,
    })) ?? [];
  const proposalActions = planSnapshot ? { controlsEnabled: planControlsEnabled, stale,
    onStart: approvePlan, onAdjust, onReject: rejectPlan, onOpen: openInspector } : null;

  return <>
    {snapshot ? <GraphSummaryCard snapshot={snapshot} goal={goal} plan={displayedPlan}
      onOpen={openInspector} stale={stale} />
      : planSnapshot && proposalActions
        ? <GraphPlanProposalCard snapshot={planSnapshot} actions={proposalActions} /> : null}
    {open && snapshot ? <GraphInspector snapshot={snapshot} goal={goal} plan={displayedPlan}
      controlsEnabled={controlsEnabled && !stale} onClose={closeInspector} onAction={sendAction} /> : null}
    {open && !snapshot && planSnapshot && proposalActions
      ? <GraphPlanProposalDialog snapshot={planSnapshot} actions={proposalActions}
        onClose={closeInspector} /> : null}
  </>;
}

function runtimePlanStatus(node: import("./types.ts").TaskGraphNodeView | undefined): GraphPlanItem["status"] {
  if (!node) return "planned";
  if (node.logicalState === "succeeded") return "completed";
  if (node.logicalState === "failed" || node.logicalState === "exhausted") return "failed";
  if (node.logicalState === "cancelled") return "cancelled";
  if (node.logicalState === "not_run") return "cancelled";
  if (node.currentAttempt?.state === "running") return "running";
  if (node.blocker) return "blocked";
  return node.readiness === "claimed" ? "starting" : "planned";
}
