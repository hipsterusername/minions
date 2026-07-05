import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import { checkFreshness } from "../system-model/freshness.ts";
import { getWorkPacket, listWorkPacketVerifications } from "../system-model/store.ts";
import type { Capability, Flow, WorkPacket } from "../../shared/system-model/index.ts";
import {
  getHeadSha,
  gitTimestampFn,
  modeForCompile,
  type SystemModelToolContext,
} from "./shared.ts";

const checkFreshnessInputSchema = z.object({
  workPacketId: z.string().optional(),
  objectIds: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
});

export function createCheckFreshnessToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "check_freshness",
    description:
      "Check git-derived freshness for system-model objects or for every freshness subject in a Work Packet.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: checkFreshnessInputSchema,
    handler: async (input: unknown) => {
      const args = checkFreshnessInputSchema.parse(input);
      const model = ctx.runtime.model;
      if (!model) return jsonResult({ status: "unknown", objects: [], loadErrors: ctx.runtime.loadErrors });
      const packet = args.workPacketId ? getWorkPacket(ctx.projectPath, args.workPacketId)?.packet : null;
      const ids = args.objectIds ?? packetIds(packet ?? null) ?? model.capabilities.map((capability) => capability.id);
      const objects = ids.flatMap((id) => {
        const object = model.objectsById.get(id);
        return object?.type === "capability" || object?.type === "flow" ? [object] : [];
      });
      const verifiedTargets = args.workPacketId
        ? listWorkPacketVerifications(ctx.projectPath, args.workPacketId)
          .filter((row) => row.kind === "freshness" && row.result === "passed")
          .map((row) => row.target)
        : [];
      const report = await checkFreshness({
        cwd: ctx.cwd,
        headSha: await getHeadSha(ctx),
        mode: modeForCompile(ctx.runtime),
        subjects: objects.map((object) => ({
          objectId: object.id,
          objectFile: objectFileFor(object),
          globs: args.files ?? object.suggestedFiles,
          freshnessClass: object.freshness?.class,
          policyClass: "ordinary",
        })),
        policies: model.policies.freshness,
        getTimestamps: ctx.timestampFn ?? gitTimestampFn,
        verifiedTargets,
      });
      return jsonResult(report);
    },
  };
}

function packetIds(packet: WorkPacket | null): string[] | null {
  if (!packet) return null;
  return [...packet.scope.capabilities, ...packet.scope.flows];
}

function objectFileFor(object: Capability | Flow): string {
  return `.systemmodel/${object.type === "capability" ? "capabilities" : "flows"}/${object.id.split(".")[1]}.yaml`;
}
