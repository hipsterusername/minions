/**
 * Client preview helpers for the server-owned Leader prompt.
 *
 * Wire callers use `buildLeaderSystemPrompt` to send only structured
 * customization (the user prefix and frozen selected-skill instructions).
 * `buildLeaderSystemPromptPreview` is for UI/tests and is never authoritative.
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
import { builtInSkillPresets } from "../../shared/skill-presets.ts";
import { encodeLeaderPromptCustomization } from "../../shared/leader-prompt.ts";

/**
 * The catalog the leader can arm minions from: every project skill in the
 * registry plus every built-in preset it does not already override. Built-in
 * presets (e.g. the Skill Builder) live in `shared/` and are resolvable
 * server-side by `assign_task`, so surfacing them here lets the leader
 * discover and grant them by id.
 */
function armableSkills(): SkillTemplate[] {
  const project = getAllSkills();
  const projectIds = new Set(project.map((s) => s.id));
  const builtIns = builtInSkillPresets.filter((p) => !projectIds.has(p.id));
  return [...project, ...(builtIns as SkillTemplate[])];
}

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
  const taggedSkills = input.skillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);
  return encodeLeaderPromptCustomization({
    promptPrefix: input.systemPromptPrefix,
    skillsAddendum: compileSkills(taggedSkills, input.skillValues),
  });
}

export function buildLeaderSystemPromptPreview(input: BuildLeaderPromptInput): string {
  const tools = input.tools ?? CLAUDE_BUILT_IN_TOOLS;
  const taggedSkills = input.skillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);
  const activeAddendum = compileSkills(taggedSkills, input.skillValues);
  const inventory = buildArmingInventory(armableSkills());
  const prefix = input.systemPromptPrefix?.trim();
  return buildBaseLeaderPrompt(tools) + activeAddendum + inventory
    + (prefix ? `\n\n${prefix}` : "");
}
