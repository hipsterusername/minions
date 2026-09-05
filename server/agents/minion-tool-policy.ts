/** Tool identities implied by skills armed on a Minion run. */

export const SKILL_BUILDER_ID = "skill-builder";

export const MINION_MCP_TOOLS_BASE = [
  "mcp__minion-status__report_step",
  "mcp__minion-status__report_done",
  "mcp__minion-status__report_fail",
  "mcp__minion-status__report_blocked",
];

export const SKILL_AUTHORING_TOOLS = [
  "mcp__skills__list_skills",
  "mcp__skills__get_skill",
  "mcp__skills__create_skill",
  "mcp__skills__update_skill",
  "mcp__skills__delete_skill",
];

export function minionSkillMcpToolNames(skillIds: readonly string[]): string[] {
  return [
    "mcp__skills__load_skill",
    "mcp__skills__load_subskill",
    "mcp__skills__load_skill_attachment",
    ...(skillIds.includes(SKILL_BUILDER_ID) ? SKILL_AUTHORING_TOOLS : []),
  ];
}
