import type { SkillTemplate } from "../../../skills/types.ts";
import type { SlashCommand } from "./slash-commands.ts";

/** Only complete a standalone @ token at the caret, never an email address. */
export function parseSkillMention(input: string, caret: number) {
  const before = input.slice(0, caret);
  const match = /(?:^|[\s(])@([\p{L}\p{N}_:./-]*)$/u.exec(before);
  if (!match) return null;
  const query = match[1]!;
  const suffix = /^[\p{L}\p{N}_:./-]*/u.exec(input.slice(caret))![0];
  return { query, start: caret - query.length - 1, end: caret + suffix.length };
}

export function buildSkillMentions(skills: SkillTemplate[]): SlashCommand[] {
  return skills.map((skill) => ({
    id: skill.id,
    label: skill.name,
    description: skill.description,
    insertText: `@${skill.id}`,
    aliases: [skill.id],
  }));
}
