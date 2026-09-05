import { z } from "zod/v4";
import { captureEvidenceBinding } from "../system-model/evidence-binding.ts";
import { loadSystemModel } from "../system-model/load.ts";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import {
  getWorkPacket,
  listWorkPacketVerifications,
  recordWorkPacketVerification,
  saveWorkPacket,
} from "../system-model/store.ts";
import type { SystemModelToolContext } from "./shared.ts";

const recordVerificationInputSchema = z.object({
  workPacketId: z.string().min(1),
  kind: z.enum(["freshness", "test", "manual_review", "constraint"]),
  target: z.string().min(1),
  result: z.enum(["passed", "failed", "not_run", "unknown"]),
  notes: z.string().optional(),
});

export function createRecordVerificationToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "record_verification",
    description:
      "Record a required Work Packet verification row. Passing all required rows activates a stale_blocked packet.",
    inputSchema: recordVerificationInputSchema,
    handler: async (input: unknown) => {
      const args = recordVerificationInputSchema.parse(input);
      const now = ctx.now?.() ?? Date.now();
      const stored = getWorkPacket(ctx.projectPath, args.workPacketId);
      if (!stored || stored.packet.leaderSessionKey !== ctx.leaderSessionKey) {
        throw new Error("Work Packet is missing or belongs to another session");
      }
      const evidenceDigest = await captureEvidenceBinding(ctx.cwd, stored.packet, loadSystemModel(ctx.cwd).model, ctx.projectPath);
      recordWorkPacketVerification(ctx.projectPath, {
        evidenceDigest,
        workPacketId: args.workPacketId,
        kind: args.kind,
        target: args.target,
        result: args.result,
        notes: args.notes ?? null,
        recordedAt: now,
      });
      const rows = listWorkPacketVerifications(ctx.projectPath, args.workPacketId);
      const passed = new Set(rows.filter((row) => row.result === "passed" && row.evidenceDigest === evidenceDigest)
        .map((row) => `${row.kind}:${row.target}`));
      const required = stored.packet.freshness.requiredVerifications;
      const packet = {
        ...stored.packet,
        freshness: {
          ...stored.packet.freshness,
          status: stored.packet.freshness.status === "stale_blocked" && required.every((item) => passed.has(`${item.kind}:${item.target}`))
            ? "partially_stale" as const
            : stored.packet.freshness.status,
          requiredVerifications: required.map((item) => ({
            ...item,
            status: passed.has(`${item.kind}:${item.target}`) ? "passed" as const : item.status,
          })),
        },
        status: stored.packet.status === "draft" && required.length > 0 && required.every((item) => passed.has(`${item.kind}:${item.target}`))
          ? "active" as const
          : stored.packet.status,
      };
      saveWorkPacket(ctx.projectPath, packet, stored.contextPack, now);
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "work_packet_verification_recorded",
        workPacketId: args.workPacketId,
        kind: args.kind,
        target: args.target,
        result: args.result,
      });
      return jsonResult({ recorded: true, packet, verifications: rows });
    },
  };
}
