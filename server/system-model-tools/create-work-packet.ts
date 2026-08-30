import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import { compileWorkPacket } from "../system-model/compile.ts";
import { matchSystemModel, type MatchCandidate } from "../system-model/match.ts";
import { saveWorkPacket } from "../system-model/store.ts";
import {
  createPacketId,
  getHeadSha,
  gitTimestampFn,
  modeForCompile,
  normalizeGoal,
  type SystemModelToolContext,
} from "./shared.ts";

const createWorkPacketInputSchema = z.object({
  userRequest: z.string().min(1),
  taskIds: z.array(z.string()).optional(),
  objectIds: z.array(z.string()).optional().describe("Leader-confirmed system-model object ids from the pre-filter candidates."),
  entryPoints: z.array(z.object({
    capabilityId: z.string().regex(/^capability\.[a-z0-9_]+$/),
    surfaceId: z.string().regex(/^surface\.[a-z0-9_]+$/),
  })).optional().describe("Leader-confirmed capability and surface entry-point pairs."),
  files: z.array(z.string()).optional(),
  ownedPaths: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
  normalizedGoal: z.string().optional(),
});

export function createCreateWorkPacketToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "create_work_packet",
    description:
      "Compile and persist a system-model Work Packet for a task. First inspect the deterministic candidates, then pass confirmed object ids, including surfaces, as objectIds when known.",
    inputSchema: createWorkPacketInputSchema,
    handler: async (input: unknown) => {
      const args = createWorkPacketInputSchema.parse(input);
      const model = ctx.runtime.model;
      if (!model) return jsonResult({ packet: null, contextPack: "", loadErrors: ctx.runtime.loadErrors });
      const prefilter = matchSystemModel({ model, request: args.userRequest, files: args.files });
      const confirmedIds = unique([
        ...(args.objectIds ?? []),
        ...confirmedEntryPointCapabilityIds(args.entryPoints, model),
      ]);
      const candidates = confirmedCandidates(confirmedIds, prefilter.candidates, model);
      const now = ctx.now?.() ?? Date.now();
      const compiled = await compileWorkPacket({
        model,
        cwd: ctx.cwd,
        headSha: await getHeadSha(ctx),
        mode: modeForCompile(ctx.runtime),
        userRequest: args.userRequest,
        normalizedGoal: args.normalizedGoal ?? normalizeGoal(args.userRequest),
        matchedCandidates: candidates.length > 0 ? candidates : prefilter.candidates,
        matchConfidence: candidates.length > 0 ? prefilter.matchConfidence : "low",
        taskFiles: args.files,
        ownedPaths: args.ownedPaths,
        acceptanceCriteria: args.acceptanceCriteria,
        timestampFn: ctx.timestampFn ?? gitTimestampFn,
        now,
        packetId: createPacketId(now, args.userRequest),
        leaderSessionKey: ctx.leaderSessionKey,
      });
      saveWorkPacket(ctx.projectPath, compiled.packet, compiled.contextPack, now);
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "work_packet_created",
        workPacketId: compiled.packet.id,
        packet: compiled.packet,
      });
      return jsonResult({
        packet: compiled.packet,
        contextPack: compiled.contextPack,
        packetRequired: compiled.packetRequired,
        match: {
          candidates: prefilter.candidates,
          matchConfidence: compiled.packet.matchConfidence,
          fallbackInstruction: prefilter.fallbackInstruction,
        },
        freshness: compiled.freshnessReport,
      });
    },
  };
}

function confirmedEntryPointCapabilityIds(
  selections: Array<{ capabilityId: string; surfaceId: string }> | undefined,
  model: NonNullable<SystemModelToolContext["runtime"]["model"]>,
): string[] {
  return (selections ?? []).flatMap((selection) => {
    const capability = model.capabilities.find((item) => item.id === selection.capabilityId);
    return capability?.entryPoints.some((entryPoint) => entryPoint.surface === selection.surfaceId)
      ? [capability.id]
      : [];
  });
}

function confirmedCandidates(
  ids: string[] | undefined,
  prefilter: MatchCandidate[],
  model: NonNullable<SystemModelToolContext["runtime"]["model"]>,
): MatchCandidate[] {
  if (!ids || ids.length === 0) return [];
  const byId = new Map(prefilter.map((candidate) => [candidate.id, candidate]));
  return ids.flatMap((id) => {
    const object = model.objectsById.get(id);
    if (!object) return [];
    return [byId.get(id) ?? {
    id,
    type: object.type,
    score: 0,
    reasons: ["confirmed by leader"],
    }];
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
