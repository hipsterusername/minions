import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import { compileWorkPacket } from "../system-model/compile.ts";
import { getWorkPacket, saveWorkPacket } from "../system-model/store.ts";
import {
  getHeadSha,
  gitTimestampFn,
  modeForCompile,
  type SystemModelToolContext,
} from "./shared.ts";

const amendWorkPacketInputSchema = z.object({
  workPacketId: z.string().min(1),
  reason: z.string().min(1),
  scopeDelta: z.object({
    addObjectIds: z.array(z.string()).default([]),
    removeObjectIds: z.array(z.string()).default([]),
    files: z.array(z.string()).optional(),
    ownedPaths: z.array(z.string()).optional(),
    note: z.string().optional(),
  }),
});

export function createAmendWorkPacketToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "amend_work_packet",
    description:
      "Recompile an existing Work Packet after replanning. Every amendment requires a reason and is appended to amendments[].",
    inputSchema: amendWorkPacketInputSchema,
    handler: async (input: unknown) => {
      const args = amendWorkPacketInputSchema.parse(input);
      const model = ctx.runtime.model;
      const stored = getWorkPacket(ctx.projectPath, args.workPacketId);
      if (!model || !stored) return jsonResult({ packet: null, contextPack: "", found: Boolean(stored) });
      const remove = new Set(args.scopeDelta.removeObjectIds);
      const ids = unique([
        ...stored.packet.scope.capabilities,
        ...stored.packet.scope.flows,
        ...args.scopeDelta.addObjectIds,
      ].filter((id) => !remove.has(id)));
      const now = ctx.now?.() ?? Date.now();
      const compiled = await compileWorkPacket({
        model,
        cwd: ctx.cwd,
        headSha: await getHeadSha(ctx),
        mode: modeForCompile(ctx.runtime),
        userRequest: stored.packet.userRequest,
        normalizedGoal: stored.packet.normalizedGoal,
        matchedCandidates: ids.map((id) => ({
          id,
          type: id.startsWith("flow.") ? "flow" : "capability",
          score: 0,
          reasons: ["amended scope"],
        })),
        matchConfidence: stored.packet.matchConfidence,
        taskFiles: args.scopeDelta.files ?? stored.packet.scope.suggestedFiles,
        ownedPaths: args.scopeDelta.ownedPaths,
        timestampFn: ctx.timestampFn ?? gitTimestampFn,
        now,
        existingPacket: stored.packet,
        amendment: { reason: args.reason, delta: JSON.stringify(args.scopeDelta) },
      });
      saveWorkPacket(ctx.projectPath, compiled.packet, compiled.contextPack, now);
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "work_packet_amended",
        workPacketId: compiled.packet.id,
        packet: compiled.packet,
      });
      return jsonResult({ packet: compiled.packet, contextPack: compiled.contextPack, freshness: compiled.freshnessReport });
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
