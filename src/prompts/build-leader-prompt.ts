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

import {
  buildBaseLeaderPrompt,
  CLAUDE_BUILT_IN_TOOLS,
} from "./leader-system.ts";
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
  /** Optional text prepended to the generated system prompt. */
  systemPromptPrefix?: string | null | undefined;
  /**
   * Coding tool names to inject into the "Your Capabilities" section.
   * Defaults to the Claude built-in tool list.
   */
  tools?: readonly string[];
}

export function buildLeaderSystemPrompt(input: BuildLeaderPromptInput): string {
  const tools = input.tools ?? CLAUDE_BUILT_IN_TOOLS;
  const taggedSkills = input.skillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);
  const activeAddendum = compileSkills(taggedSkills, input.skillValues);
  const inventory = buildArmingInventory(getAllSkills());
  const prefix = input.systemPromptPrefix?.trim();
  return (prefix ? `${prefix}\n\n` : "") + buildBaseLeaderPrompt(tools) + activeAddendum + inventory;
}
