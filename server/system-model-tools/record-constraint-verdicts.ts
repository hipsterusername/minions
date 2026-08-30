import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import { constraintCheckSchema, reconciliationReportSchema } from "../../shared/system-model/index.ts";
import {
  getWorkPacket,
  getLatestReconciliationReportForPacket,
  saveReconciliationReport,
  updateWorkPacketStatus,
} from "../system-model/store.ts";
import type { SystemModelToolContext } from "./shared.ts";

const recordConstraintVerdictsInputSchema = z.object({
  workPacketId: z.string().min(1),
  verdicts: z.array(constraintCheckSchema),
});

export function createRecordConstraintVerdictsToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "record_constraint_verdicts",
    description:
      "Validate reviewer-minion ConstraintCheck[] output and merge it with provenance; reconcile only after constraints, acceptance coverage, and model-update review are complete.",
    inputSchema: recordConstraintVerdictsInputSchema,
    handler: async (input: unknown) => {
      const args = recordConstraintVerdictsInputSchema.parse(input);
      const base = getLatestReconciliationReportForPacket(ctx.projectPath, args.workPacketId);
      if (!base) return jsonResult({ recorded: false, error: "No reconciliation report found for Work Packet" }, { isError: true });
      const outOfScopeVerdict = args.verdicts.find((verdict) =>
        !base.deterministic.constraintsInScope.includes(verdict.constraintId));
      if (outOfScopeVerdict) {
        throw new Error(`Constraint ${outOfScopeVerdict.constraintId} is not in the reconciliation scope`);
      }

      const now = ctx.now?.() ?? Date.now();
      const newVerdicts = args.verdicts.map((verdict) => ({
        ...verdict,
        provenance: "minion_judged" as const,
        reviewedAt: now,
      }));
      const verdicts = mergeByConstraintId(base.constraintVerdicts, newVerdicts);
      const constraintChecks = mergeByConstraintId(base.constraintChecks, args.verdicts);
      const report = reconciliationReportSchema.parse({
        ...base,
        constraintVerdicts: verdicts,
        constraintChecks,
        provenance: {
          ...base.provenance,
          constraintVerdicts: "minion_judged",
          ...(base.systemModelUpdate.provenance === "leader_judged"
            ? { systemModelUpdate: "leader_judged" as const } : {}),
        },
      });
      saveReconciliationReport(ctx.projectPath, report);
      const reviewed = new Set(verdicts.map((verdict) => verdict.constraintId));
      const missingConstraintVerdicts = report.deterministic.constraintsInScope
        .filter((constraintId) => !reviewed.has(constraintId));
      const pendingActions = [
        ...(missingConstraintVerdicts.length > 0
          ? [`Record verdicts for: ${missingConstraintVerdicts.join(", ")}`] : []),
        ...(report.acceptanceCoverage.status === "incomplete"
          ? [`Resolve acceptance coverage for: ${report.acceptanceCoverage.unresolvedCriterionIds.join(", ")}`] : []),
        ...(report.systemModelUpdate.status === "review_required"
          ? ["Resolve the system-model update assessment by rerunning reconcile_run"] : []),
      ];
      const packet = pendingActions.length === 0
        ? updateWorkPacketStatus(ctx.projectPath, args.workPacketId, "reconciled", now)
        : getWorkPacket(ctx.projectPath, args.workPacketId)?.packet ?? null;
      if (pendingActions.length === 0) {
        ctx.bus.emitToSession(ctx.leaderSessionKey, {
          type: "reconciliation_ready",
          workPacketId: args.workPacketId,
          reportId: report.id,
          report,
        });
      }
      return jsonResult({ recorded: true, report, packet, pendingActions });
    },
  };
}

function mergeByConstraintId<T extends { constraintId: string }>(current: T[], updates: T[]): T[] {
  const merged = new Map(current.map((item) => [item.constraintId, item]));
  for (const update of updates) merged.set(update.constraintId, update);
  return [...merged.values()].sort((a, b) => a.constraintId.localeCompare(b.constraintId));
}
