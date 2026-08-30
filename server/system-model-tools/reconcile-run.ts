import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import {
  reconciliationReportSchema,
  systemModelUpdateAssessmentSchema,
  type Constraint,
  type ReconciliationReport,
} from "../../shared/system-model/index.ts";
import { reconcileDeterministic } from "../system-model/reconcile.ts";
import {
  getWorkPacket,
  saveReconciliationReport,
  updateWorkPacketStatus,
} from "../system-model/store.ts";
import type { SystemModelToolContext } from "./shared.ts";

const reconcileRunInputSchema = z.object({
  workPacketId: z.string().min(1),
  agentSummary: z.string().min(1),
  systemModelUpdate: systemModelUpdateAssessmentSchema.optional(),
});

export function createReconcileRunToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "reconcile_run",
    description:
      "Build a deterministic reconciliation report for a Work Packet and, when constraints are in scope, generate the reviewer-minion task description.",
    inputSchema: reconcileRunInputSchema,
    handler: async (input: unknown) => {
      const args = reconcileRunInputSchema.parse(input);
      const model = ctx.runtime.model;
      const stored = getWorkPacket(ctx.projectPath, args.workPacketId);
      if (!model || !stored) return jsonResult({ report: null, found: Boolean(stored), loadErrors: ctx.runtime.loadErrors });
      if (!ctx.getDetailedDiff) return jsonResult({ report: null, error: "reconcile_run requires a diff provider" }, { isError: true });

      const now = ctx.now?.() ?? Date.now();
      const deterministic = reconcileDeterministic({
        model,
        packet: stored.packet,
        diff: await ctx.getDetailedDiff(),
      });
      if (args.systemModelUpdate?.status === "updated"
        && deterministic.changedModelFiles.length === 0) {
        throw new Error("An updated system-model assessment requires a changed .systemmodel file in the actual diff");
      }
      const unknownAssessmentObject = args.systemModelUpdate?.objectIds.find((id) =>
        !model.objectsById.has(id));
      if (unknownAssessmentObject) {
        throw new Error(`Unknown system-model object ${unknownAssessmentObject}`);
      }
      const missingAssessmentObject = args.systemModelUpdate?.objectIds.length
        ? deterministic.candidateModelObjects.find((id) =>
          !args.systemModelUpdate!.objectIds.includes(id))
        : undefined;
      if (missingAssessmentObject) {
        throw new Error(`System-model assessment does not cover candidate object ${missingAssessmentObject}`);
      }
      const systemModelUpdate = deriveSystemModelUpdate(deterministic, args.systemModelUpdate);
      const unresolvedCriterionIds = (stored.packet.criterionCoverage ?? [])
        .filter((criterion) => !["supported", "verified", "waived"].includes(criterion.status))
        .map((criterion) => criterion.criterionId);
      const acceptanceCoverage = {
        status: unresolvedCriterionIds.length === 0 ? "complete" as const : "incomplete" as const,
        unresolvedCriterionIds,
      };
      const constraints = model.constraints.filter((constraint) =>
        deterministic.constraintsInScope.includes(constraint.id));
      const reviewerTaskDescription = constraints.length > 0
        ? renderReviewerTask({
          workPacketId: args.workPacketId,
          agentSummary: args.agentSummary,
          deterministic,
          constraints,
          suggestedTests: stored.packet.scope.suggestedTests,
        })
        : undefined;
      const report = reconciliationReportSchema.parse({
        id: createReconciliationId(now, args.workPacketId),
        workPacketId: args.workPacketId,
        createdAt: now,
        deterministic,
        agentSummary: args.agentSummary,
        reviewerTaskDescription,
        systemModelUpdate,
        acceptanceCoverage,
        provenance: {
          deterministic: "deterministic",
          ...(systemModelUpdate.provenance === "leader_judged"
            ? { systemModelUpdate: "leader_judged" as const } : {}),
        },
        affectedObjects: [...deterministic.affectedCapabilities, ...deterministic.affectedFlows],
        changedFiles: deterministic.changedFiles,
        testsMissing: deterministic.testsMissing,
        outOfScopeFiles: deterministic.outOfScopeFiles,
        gates: deterministic.gateRequirements,
        constraintChecks: [],
      });
      saveReconciliationReport(ctx.projectPath, report);
      const pendingActions = [
        ...(acceptanceCoverage.status === "incomplete"
          ? [`Resolve acceptance coverage for: ${unresolvedCriterionIds.join(", ")}`] : []),
        ...(systemModelUpdate.status === "review_required"
          ? ["Assess candidate system-model objects; update and validate the model, or record an evidence-backed no-change decision"] : []),
        ...(constraints.length > 0 ? ["Record reviewer constraint verdicts"] : []),
      ];
      const packet = pendingActions.length === 0
        ? updateWorkPacketStatus(ctx.projectPath, args.workPacketId, "reconciled", now)
        : stored.packet;
      return jsonResult({ report, reviewerTaskDescription, pendingActions, packet });
    },
  };
}

function deriveSystemModelUpdate(
  deterministic: ReconciliationReport["deterministic"],
  assessment: z.infer<typeof systemModelUpdateAssessmentSchema> | undefined,
): ReconciliationReport["systemModelUpdate"] {
  const candidates = deterministic.candidateModelObjects;
  if (assessment) {
    return {
      status: assessment.status,
      candidateObjectIds: unique(assessment.objectIds.length > 0 ? assessment.objectIds : candidates),
      changedModelFiles: deterministic.changedModelFiles,
      rationale: assessment.rationale,
      evidence: assessment.evidence,
      provenance: "leader_judged",
    };
  }
  if (candidates.length === 0 && deterministic.changedModelFiles.length === 0) {
    return {
      status: "not_needed",
      candidateObjectIds: [],
      changedModelFiles: [],
      evidence: [],
      provenance: "deterministic",
    };
  }
  return {
    status: "review_required",
    candidateObjectIds: candidates,
    changedModelFiles: deterministic.changedModelFiles,
    rationale: "The actual diff intersects modeled implementation surfaces; canonical guidance may need revision.",
    evidence: [deterministic.diffSummary],
    provenance: "deterministic",
  };
}

function renderReviewerTask(input: {
  workPacketId: string;
  agentSummary: string;
  deterministic: ReconciliationReport["deterministic"];
  constraints: Constraint[];
  suggestedTests: string[];
}): string {
  const constraintLines = input.constraints.map((constraint) => [
    `- ${constraint.id}: ${constraint.statement}`,
    constraint.agentInstruction ? `  agent_instructions: ${constraint.agentInstruction}` : "",
    constraint.suggestedTests.length > 0 ? `  suggested_tests: ${constraint.suggestedTests.join(", ")}` : "",
  ].filter(Boolean).join("\n"));
  return [
    `Review system-model constraints for Work Packet ${input.workPacketId}.`,
    "Read-only review only. Do not edit files.",
    "",
    "Agent summary:",
    input.agentSummary,
    "",
    "Diff summary:",
    input.deterministic.diffSummary,
    "",
    "Constraints:",
    constraintLines.join("\n"),
    "",
    `Suggested tests: ${input.suggestedTests.join(", ") || "none"}`,
    "",
    "Required output: report_done with a JSON array matching ConstraintCheck[] exactly:",
    `[{"constraintId":"constraint.example","status":"appears_satisfied|possibly_violated|violated|not_checked","evidence":["file/path.ts:line or observed fact"],"notes":"optional"}]`,
  ].join("\n");
}

function createReconciliationId(now: number, workPacketId: string): string {
  return `recon_${now.toString(36)}_${workPacketId.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 40)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
