/**
 * Sub-skill retrieval MCP tool for armed Minion agents.
 *
 * When the leader arms a minion with a skill that has sub-skills, the compiled
 * skill map is appended to the minion's system prompt (via `compileSkills`).
 * This tool lets the minion pull a specific sub-skill body into context on
 * demand — the mirror of the leader's `load_subskill` tool, backed by the same
 * tolerant `resolveSubskillBody`.
 *
 * Returns NormalizedToolDef[] which agents/minion.ts places into a toolGroup
 * keyed "skills". ClaudeHarness.registerTools() wraps them as a named MCP
 * server so tool calls follow the mcp__skills__* pattern.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "./harness/types.ts";
import { textResult } from "./harness/tool-result.ts";
import { formatSubskillLoad, resolveSubskillBody } from "./subskills.ts";

const loadSubskillInputSchema = z.object({
  skillId: z
    .string()
    .describe("The id of the parent skill (shown in its sub-skill map)."),
  subskillId: z
    .string()
    .describe("The id of the sub-skill to load (shown in the map)."),
});

export function createSubskillToolsForSession(opts: {
  projectPath: string;
}): { toolDefs: NormalizedToolDef[] } {
  const { projectPath } = opts;
  const loadSubskill: NormalizedToolDef = {
    name: "load_subskill",
    description:
      "Pull a sub-skill's full body into context on demand. A skill you were " +
      "armed with injects only a map of its sub-skills; call this with the " +
      "parent skillId and the sub-skill's subskillId to load one when needed.",
    inputSchema: loadSubskillInputSchema,
    handler: async (input: unknown) => {
      const { skillId, subskillId } = loadSubskillInputSchema.parse(input);
      const result = resolveSubskillBody(projectPath, skillId, subskillId);
      return textResult(formatSubskillLoad(skillId, subskillId, result));
    },
  };
  return { toolDefs: [loadSubskill] };
}
