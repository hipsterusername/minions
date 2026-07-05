import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import {
  orphanedObjects,
  staleObjects,
  unusedInLastNPackets,
  type UsageObject,
} from "../system-model/usage.ts";
import {
  getHeadSha,
  gitTimestampFn,
  modeForCompile,
  type SystemModelToolContext,
} from "./shared.ts";

const modelHealthInputSchema = z.object({
  unusedPacketWindow: z.number().int().positive().max(500).default(30),
});

interface PruneRecommendation {
  id: string;
  type: UsageObject["type"];
  label: string;
  reasons: string[];
  recommendation: "prune_or_update" | "prune_or_link" | "review_for_prune";
}

export function createModelHealthToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "model_health",
    description:
      "Report unused, stale, and orphaned system-model objects with prune recommendations.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: modelHealthInputSchema,
    handler: async (input: unknown) => {
      const args = modelHealthInputSchema.parse(input);
      const model = ctx.runtime.model;
      if (!model) {
        return jsonResult({
          unused: [],
          stale: [],
          orphaned: [],
          pruneRecommendations: [],
          loadErrors: ctx.runtime.loadErrors,
        });
      }
      const [unused, stale, orphaned] = await Promise.all([
        unusedInLastNPackets({
          projectPath: ctx.projectPath,
          model,
          n: args.unusedPacketWindow,
        }),
        staleObjects({
          model,
          cwd: ctx.cwd,
          headSha: await getHeadSha(ctx),
          mode: modeForCompile(ctx.runtime),
          timestampFn: ctx.timestampFn ?? gitTimestampFn,
        }),
        Promise.resolve(orphanedObjects(model)),
      ]);
      return jsonResult({
        unused,
        stale,
        orphaned,
        pruneRecommendations: recommendations(unused, stale, orphaned),
      });
    },
  };
}

function recommendations(
  unused: UsageObject[],
  stale: UsageObject[],
  orphaned: UsageObject[],
): PruneRecommendation[] {
  const reasons = new Map<string, string[]>();
  const byId = new Map<string, UsageObject>();
  for (const item of [...unused, ...stale, ...orphaned]) {
    byId.set(item.id, item);
    reasons.set(item.id, [...(reasons.get(item.id) ?? []), item.reason]);
  }
  return [...reasons.entries()].map(([id, itemReasons]) => {
    const item = byId.get(id)!;
    return {
      id,
      type: item.type,
      label: item.label,
      reasons: itemReasons,
      recommendation: recommendationFor(itemReasons),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function recommendationFor(reasons: string[]): PruneRecommendation["recommendation"] {
  const hasStale = reasons.some((reason) => reason.includes("older than matching code"));
  const hasOrphan = reasons.some((reason) => reason.includes("No inbound links"));
  if (hasStale) return "prune_or_update";
  if (hasOrphan) return "prune_or_link";
  return "review_for_prune";
}
