/** Shared skill disclosure compiler used by previews and every agent path. */
import { formatSkillAttachmentIndex, type SkillAttachment } from "./skill-attachments.ts";

export interface PromptSkill {
  id: string;
  name: string;
  template: string;
  variables?: { name: string; defaultValue?: string }[];
  attachments?: SkillAttachment[];
  subskills?: { id: string; name: string; description: string; body: string;
    whenToUse?: string; alwaysInclude?: boolean; attachments?: SkillAttachment[] }[];
}

export function compileSkillTemplate(
  skill: PromptSkill,
  values: Record<string, string>,
): string {
  let result = skill.template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, name: string) => values[name] ?? skill.variables?.find((v) => v.name === name)?.defaultValue ?? "",
  );
  // Collapse runs of blank lines left behind by missing optional values.
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Compile a list of skills into a single Markdown addendum, suitable
 * for appending to an agent's system prompt.
 */
export function compileSkills(
  skills: PromptSkill[],
  allValues: Record<string, Record<string, string>>,
): string {
  if (skills.length === 0) return "";
  const sections = skills.map((skill) => {
    const values = allValues[skill.id] ?? {};
    const compiled = compileSkillTemplate(skill, values);
    const attachments = formatSkillAttachmentIndex(
      skill.attachments,
      skill.id,
    );
    const map = buildSubskillMap(skill);
    return `## Skill: ${skill.name}\n\n${compiled}`
      + (attachments ? `\n\n${attachments}` : "")
      + (map ? `\n\n${map}` : "");
  });
  return (
    `\n\n# Active Skills\n\n` +
    `The following skills are active for this session. ` +
    `Follow their instructions.\n\n` +
    sections.join("\n\n---\n\n")
  );
}

export function buildSubskillMap(skill: PromptSkill): string {
  const subskills = skill.subskills ?? [];
  if (subskills.length === 0) return "";

  const bullets = subskills.map((sub) => {
    const desc = sub.description?.trim() || "(no description)";
    const when = sub.whenToUse?.trim()
      ? ` When to use: ${sub.whenToUse.trim()}`
      : "";
    const loaded = sub.alwaysInclude ? " (loaded below)" : "";
    return `- \`${sub.id}\` — **${sub.name}**: ${desc}.${when}${loaded}`;
  });

  const eager = subskills
    .filter((sub) => sub.alwaysInclude)
    .map((sub) => {
      const attachments = formatSkillAttachmentIndex(
        sub.attachments,
        skill.id, sub.id,
      );
      return `#### ${sub.name}\n\n${sub.body.trim()}`
        + (attachments ? `\n\n${attachments}` : "");
    });

  const parts = [
    `### Sub-skills of ${skill.name}`,
    `Sub-skills marked loaded below are already included; all others load on demand. ` +
      `To pull one into context, call \`load_subskill\` with ` +
      `\`skillId: "${skill.id}"\` and the sub-skill's id.`,
    bullets.join("\n"),
  ];
  if (eager.length > 0) parts.push(eager.join("\n\n"));
  return parts.join("\n\n");
}
