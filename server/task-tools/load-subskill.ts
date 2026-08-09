/**
 * load_subskill tool — pull a sub-skill body into context on demand.
 *
 * A parent skill's compiled prompt always injects a *map* of its sub-skills
 * (name + when-to-use + description). The full body is not included until the
 * agent calls this tool with the parent skill id and the sub-skill id. Backed
 * by the shared, tolerant `resolveSubskillBody` — unknown ids never throw.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { textResult } from "../harness/tool-result.ts";
import type { TaskToolContext } from "./types.ts";
import { formatSubskillLoad, resolveSubskillBody } from "../subskills.ts";

const loadSubskillInputSchema = z.object({
  skillId: z
    .string()
    .describe("The id of the parent skill (shown in its sub-skill map)."),
  subskillId: z
    .string()
    .describe("The id of the sub-skill to load (shown in the map)."),
});

export function createLoadSubskillToolDef(
  ctx: TaskToolContext,
): NormalizedToolDef {
  return {
    name: "load_subskill",
    description:
      "Pull a sub-skill's full body into context on demand. Parent skills " +
      "inject only a map of their sub-skills; call this with the parent " +
      "skillId and the sub-skill's subskillId to load one when a task needs it.",
    inputSchema: loadSubskillInputSchema,
    handler: async (input: unknown) => {
      const { skillId, subskillId } = loadSubskillInputSchema.parse(input);
      const result = resolveSubskillBody(ctx.projectPath, skillId, subskillId);
      return textResult(formatSubskillLoad(skillId, subskillId, result));
    },
  };
}
