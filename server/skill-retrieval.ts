import { z } from "zod/v4";
import type { NormalizedToolDef } from "./harness/types.ts";
import { textResult } from "./harness/tool-result.ts";
import { compileSkills } from "./skills.ts";
import { formatSubskillLoad, resolveSubskillBody } from "./subskills.ts";
import { sanitizeSkillAttachments } from "../shared/skill-attachments.ts";
import { captureSkillSnapshot, readSkillSnapshot } from "./skill-snapshot.ts";

export const SKILL_ATTACHMENT_PAGE_CHARS = 12_000;

export function createSkillRetrievalTools(opts: {
  projectPath: string;
  skillSnapshotId?: string | undefined;
  skillValues?: Record<string, Record<string, string>> | undefined;
}): NormalizedToolDef[] {
  const id = opts.skillSnapshotId ?? captureSkillSnapshot(opts.projectPath, opts.skillValues);
  const snapshot = readSkillSnapshot(opts.projectPath, id);
  const parentSchema = z.object({ skillId: z.string(), values: z.record(z.string(), z.string()).optional() });
  const subSchema = z.object({ skillId: z.string(), subskillId: z.string() });
  const attachmentSchema = z.object({
    skillId: z.string(), subskillId: z.string().optional(),
    attachmentIndex: z.number().int().min(0), offset: z.number().int().min(0).default(0),
  });
  const findSkill = (skillId: string) => snapshot.skills.find(skill => skill.id === skillId);
  const missing = (skillId: string) => textResult(`No skill with id ${JSON.stringify(skillId)} in this run's snapshot. Available skill IDs: ${snapshot.skills.map(skill => skill.id).join(", ")}.`);
  return [{
    name: "load_skill",
    description: "Read a parent skill's instructions, variable definitions, sub-skill index and attachment references from this run's snapshot. Does not grant authoring tools or change child skill selections. Supply values for template variables when needed.",
    inputSchema: parentSchema,
    handler: async input => {
      const { skillId, values } = parentSchema.parse(input);
      const skill = findSkill(skillId);
      if (!skill) return missing(skillId);
      const variables = skill.variables?.length ? `\nTemplate variables: ${JSON.stringify(skill.variables)}\n` : "";
      return textResult(`Skill snapshot: ${id}\n${variables}` + compileSkills([skill], {
        [skillId]: { ...snapshot.values[skillId], ...values },
      }));
    },
  }, {
    name: "load_subskill",
    description: "Load an advertised sub-skill body and attachment references from this run's snapshot. Use load_skill first to inspect its parent instructions and index.",
    inputSchema: subSchema,
    handler: async input => {
      const { skillId, subskillId } = subSchema.parse(input);
      return textResult(formatSubskillLoad(skillId, subskillId,
        resolveSubskillBody(opts.projectPath, skillId, subskillId, snapshot.skills)));
    },
  }, {
    name: "load_skill_attachment",
    description: "Read one frozen skill or sub-skill attachment in pages of at most 12000 characters. Use the advertised zero-based attachmentIndex and returned nextOffset; null means complete.",
    inputSchema: attachmentSchema,
    handler: async input => {
      const { skillId, subskillId, attachmentIndex, offset } = attachmentSchema.parse(input);
      const skill = findSkill(skillId);
      if (!skill) return missing(skillId);
      const owner = subskillId === undefined ? skill : skill.subskills?.find(sub => sub.id === subskillId);
      if (!owner) return textResult(`Unknown sub-skill ${JSON.stringify(subskillId)}. Call load_skill to inspect its index.`);
      const attachments = sanitizeSkillAttachments(owner.attachments);
      const attachment = attachments[attachmentIndex];
      if (!attachment) return textResult(`Unknown attachment index ${attachmentIndex}; available attachment count: ${attachments.length}.`);
      if (offset > attachment.text.length) return textResult(`Offset exceeds attachment length ${attachment.text.length}.`);
      const end = Math.min(offset + SKILL_ATTACHMENT_PAGE_CHARS, attachment.text.length);
      return textResult(JSON.stringify({ snapshotId: id, filename: attachment.filename,
        mediaType: attachment.mediaType, sourceTruncated: attachment.truncated,
        offset, totalChars: attachment.text.length, nextOffset: end < attachment.text.length ? end : null,
        text: attachment.text.slice(offset, end) }));
    },
  }];
}
