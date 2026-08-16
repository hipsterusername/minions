import {
  buildLeaderSystemPrompt,
  buildLeaderSystemPromptPreview,
} from "../../prompts/build-leader-prompt.ts";
import { getAllSkills, getSkill } from "../../skills/registry.ts";
import { compileSkills, type SkillTemplate } from "../../skills/types.ts";

export interface LeaderPromptStateInput {
  skillIds: readonly string[];
  skillValues: Record<string, Record<string, string>>;
  systemPromptPrefix?: string | null | undefined;
  orchestrationMode?: import("../../../shared/task-graph-planning-contracts.ts").LeaderOrchestrationMode | undefined;
}

export interface FrozenLeaderPrompt {
  /** Structured prefix + skill customization, never a full canonical prompt. */
  systemPrompt: string;
  /** Non-authoritative client preview of server assembly. */
  preview: string;
  activeSkillIds: readonly string[];
  activeSkillAddendum: string;
  inventoryIds: readonly string[];
}

export interface LeaderFollowUpPrompt {
  systemPrompt: string;
  prompt: string;
}

export function freezeLeaderSystemPrompt(
  input: LeaderPromptStateInput,
): FrozenLeaderPrompt {
  return {
    systemPrompt: buildLeaderSystemPrompt(input),
    preview: buildLeaderSystemPromptPreview(input),
    activeSkillIds: [...input.skillIds],
    activeSkillAddendum: compileActiveSkillAddendum(input),
    inventoryIds: getAllSkills().map((skill) => skill.id),
  };
}

export function buildFrozenLeaderFollowUpPrompt(input: {
  frozen: FrozenLeaderPrompt;
  current: LeaderPromptStateInput;
  prompt: string;
}): LeaderFollowUpPrompt {
  const reminder = buildSkillDeltaReminder(input.frozen, input.current);
  return {
    systemPrompt: input.frozen.systemPrompt,
    prompt: reminder ? `${reminder}\n\n${input.prompt}` : input.prompt,
  };
}

export function buildSkillDeltaReminder(
  frozen: FrozenLeaderPrompt,
  current: LeaderPromptStateInput,
): string | null {
  const currentInventory = getAllSkills();
  const currentInventoryIds = currentInventory.map((skill) => skill.id);
  const addedInventory = currentInventory.filter(
    (skill) => !frozen.inventoryIds.includes(skill.id),
  );
  const removedInventoryIds = frozen.inventoryIds.filter(
    (id) => !currentInventoryIds.includes(id),
  );
  const currentActiveAddendum = compileActiveSkillAddendum(current);
  const activeChanged = currentActiveAddendum !== frozen.activeSkillAddendum;

  if (!activeChanged && addedInventory.length === 0 && removedInventoryIds.length === 0) {
    return null;
  }

  const lines = ["<system-reminder>", "Skill state changed since this leader session started."];
  if (addedInventory.length > 0) {
    lines.push(
      `Newly available skills for delegation: ${addedInventory
        .map(formatSkillInventoryItem)
        .join("; ")}.`,
    );
  }
  if (removedInventoryIds.length > 0) {
    lines.push(`No longer available skills: ${removedInventoryIds.map((id) => `\`${id}\``).join(", ")}.`);
  }
  if (activeChanged) {
    lines.push(
      currentActiveAddendum
        ? `Current active leader skill instructions follow:\n${currentActiveAddendum}`
        : "No leader skills are currently active.",
    );
  }
  lines.push("</system-reminder>");
  return lines.join("\n");
}

function compileActiveSkillAddendum(input: LeaderPromptStateInput): string {
  const taggedSkills = input.skillIds
    .map((id) => getSkill(id))
    .filter((skill): skill is SkillTemplate => skill !== undefined);
  return compileSkills(taggedSkills, input.skillValues);
}

function formatSkillInventoryItem(skill: SkillTemplate): string {
  const desc = skill.description?.trim();
  return desc ? `\`${skill.id}\` (${skill.name}: ${desc})` : `\`${skill.id}\` (${skill.name})`;
}
