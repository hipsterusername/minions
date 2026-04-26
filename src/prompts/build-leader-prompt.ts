/**
 * Helper that assembles the full Leader system prompt:
 *
 *   LEADER_SYSTEM_PROMPT
 *   + Active Skills addendum (the skills tagged onto this leader node)
 *   + Available Skills inventory (the catalog of skills the leader can
 *     hand to minions via assign_task's `skillIds`)
 *
 * Centralised here so every call site (LeaderNode handlers, KanbanBoard
 * chat send) builds the prompt the same way.
 */

import { LEADER_SYSTEM_PROMPT } from "./leader-system.ts";
import { getAllSkills, getSkill } from "../skills/registry.ts";
import {
  buildArmingInventory,
  compileSkills,
  type SkillTemplate,
} from "../skills/types.ts";

export interface BuildLeaderPromptInput {
  /** IDs of skills tagged onto this Leader node (active for the leader itself). */
  skillIds: readonly string[];
  /** Variable values for the leader's tagged skills. */
  skillValues: Record<string, Record<string, string>>;
}

export function buildLeaderSystemPrompt(input: BuildLeaderPromptInput): string {
  const taggedSkills = input.skillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);
  const activeAddendum = compileSkills(taggedSkills, input.skillValues);
  const inventory = buildArmingInventory(getAllSkills());
  return LEADER_SYSTEM_PROMPT + activeAddendum + inventory;
}
