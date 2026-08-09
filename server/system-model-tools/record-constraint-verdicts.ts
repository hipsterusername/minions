import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import { constraintCheckSchema, reconciliationReportSchema } from "../../shared/system-model/index.ts";
import {
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
      "Validate reviewer-minion ConstraintCheck[] output, merge it into the latest reconciliation report with minion provenance, and mark the packet reconciled.",
    inputSchema: recordConstraintVerdictsInputSchema,
    handler: async (input: unknown) => {
      const args = recordConstraintVerdictsInputSchema.parse(input);
      const base = getLatestReconciliationReportForPacket(ctx.projectPath, args.workPacketId);
      if (!base) return jsonResult({ recorded: false, error: "No reconciliation report found for Work Packet" }, { isError: true });

      const now = ctx.now?.() ?? Date.now();
      const verdicts = args.verdicts.map((verdict) => ({
        ...verdict,
        provenance: "minion_judged" as const,
        reviewedAt: now,
      }));
      const report = reconciliationReportSchema.parse({
        ...base,
        constraintVerdicts: verdicts,
        constraintChecks: args.verdicts,
        provenance: {
          deterministic: "deterministic",
          constraintVerdicts: "minion_judged",
        },
      });
      saveReconciliationReport(ctx.projectPath, report);
      const packet = updateWorkPacketStatus(ctx.projectPath, args.workPacketId, "reconciled", now);
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "reconciliation_ready",
        workPacketId: args.workPacketId,
        reportId: report.id,
        report,
      });
      return jsonResult({ recorded: true, report, packet });
    },
  };
}
