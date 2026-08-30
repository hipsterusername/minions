import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import {
  criterionCoverageSchema,
  workPacketEvidenceSchema,
  workPacketSignalSchema,
} from "../../shared/system-model/index.ts";
import { renderWorkPacketContextPack } from "../system-model/compile.ts";
import {
  applyWorkPacketStateUpdates,
  type CriterionCoverageUpdate,
  type EvidenceAppendInput,
  type SignalUpdate,
} from "../system-model/work-packet-state.ts";
import { getWorkPacket, saveWorkPacket } from "../system-model/store.ts";
import type { SystemModelToolContext } from "./shared.ts";

const evidenceAppendSchema = workPacketEvidenceSchema
  .omit({ id: true, createdAt: true })
  .extend({
    id: z.string().min(1).optional(),
    provenance: workPacketEvidenceSchema.shape.provenance.default("leader_observed"),
  });

const coverageUpdateSchema = criterionCoverageSchema
  .pick({ criterionId: true, status: true, objectIds: true, evidenceRefs: true, notes: true, provenance: true })
  .extend({
    provenance: criterionCoverageSchema.shape.provenance.default("leader_observed"),
  });

const signalUpdateSchema = workPacketSignalSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({ id: z.string().min(1).optional() });

const recordWorkPacketEvidenceInputSchema = z.object({
  workPacketId: z.string().min(1),
  evidence: z.array(evidenceAppendSchema).default([]),
  coverageUpdates: z.array(coverageUpdateSchema).default([]),
  signalUpdates: z.array(signalUpdateSchema).default([]),
}).refine(
  (value) => value.evidence.length + value.coverageUpdates.length + value.signalUpdates.length > 0,
  { message: "At least one evidence, coverage, or signal update is required" },
);

export function createRecordWorkPacketEvidenceToolDef(
  ctx: SystemModelToolContext,
): NormalizedToolDef {
  return {
    name: "record_work_packet_evidence",
    description:
      "Append provenance-bearing Work Packet evidence and update acceptance-criterion coverage or prioritized signals without rewriting prior evidence.",
    inputSchema: recordWorkPacketEvidenceInputSchema,
    handler: async (input: unknown) => {
      const args = recordWorkPacketEvidenceInputSchema.parse(input);
      const model = ctx.runtime.model;
      const stored = getWorkPacket(ctx.projectPath, args.workPacketId);
      if (!model || !stored) {
        return jsonResult({ recorded: false, found: Boolean(stored), loadErrors: ctx.runtime.loadErrors });
      }
      const now = ctx.now?.() ?? Date.now();
      const packet = applyWorkPacketStateUpdates({
        packet: stored.packet,
        evidence: args.evidence as EvidenceAppendInput[],
        coverageUpdates: args.coverageUpdates as CriterionCoverageUpdate[],
        signalUpdates: args.signalUpdates as SignalUpdate[],
        now,
      });
      const contextPack = renderWorkPacketContextPack(model, packet);
      saveWorkPacket(ctx.projectPath, packet, contextPack, now);
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "work_packet_evidence_recorded",
        workPacketId: packet.id,
        packet,
      });
      return jsonResult({
        recorded: true,
        packet,
        contextPack,
        openSignals: (packet.signals ?? []).filter((signal) => signal.status === "open"),
      });
    },
  };
}
