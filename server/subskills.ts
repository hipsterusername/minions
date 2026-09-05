/**
 * Sub-skill map builder + on-demand body resolver.
 *
 * A skill can nest one level of {@link SubSkill}s. The parent skill's compiled
 * prompt always injects a compact *map* (built by {@link buildSubskillMap} and
 * folded into `compileSkills`); the full body of a sub-skill is pulled on
 * demand via the `load_subskill` tool, which is backed by
 * {@link resolveSubskillBody}. This module is pure server-side logic — no bus
 * events, no cross-tree imports.
 */

import { loadAllSkills, type SkillTemplate, type SubSkill } from "./skills.ts";
import { formatSkillAttachmentIndex } from "../shared/skill-attachments.ts";

export { buildSubskillMap } from "../shared/skill-prompt.ts";

/**
 * Result of resolving a sub-skill body. Tolerant by design: the caller (the
 * leader/minion LLM) may hallucinate ids, so every miss is a typed
 * discriminant rather than a throw.
 */
export type ResolveSubskillResult =
  | { ok: true; skillName: string; subskill: SubSkill }
  | { ok: false; reason: "unknown_skill"; validSkillIds: string[] }
  | { ok: false; reason: "no_subskills"; skillName: string }
  | {
      ok: false;
      reason: "unknown_subskill";
      skillName: string;
      validSubskillIds: string[];
    };

/**
 * Resolve a single sub-skill body from a project's skill library. Never throws;
 * unknown skill/sub-skill ids return a typed not-found discriminant carrying
 * the valid ids so the tool handler can surface a helpful message.
 */
export function resolveSubskillBody(
  projectPath: string,
  skillId: string,
  subskillId: string,
  skills?: readonly SkillTemplate[],
): ResolveSubskillResult {
  const all = skills ?? loadAllSkills(projectPath);
  const skill = all.find((s) => s.id === skillId);
  if (!skill) {
    return { ok: false, reason: "unknown_skill", validSkillIds: all.map((s) => s.id) };
  }
  const subskills = skill.subskills ?? [];
  if (subskills.length === 0) {
    return { ok: false, reason: "no_subskills", skillName: skill.name };
  }
  const subskill = subskills.find((s) => s.id === subskillId);
  if (!subskill) {
    return {
      ok: false,
      reason: "unknown_subskill",
      skillName: skill.name,
      validSubskillIds: subskills.map((s) => s.id),
    };
  }
  return { ok: true, skillName: skill.name, subskill };
}

/**
 * Format a {@link resolveSubskillBody} result as the text payload returned by
 * the `load_subskill` tool (shared by the leader and minion surfaces). On
 * success the body IS the payload, framed with a heading. Misses produce a
 * tolerant message listing the valid ids — never an error/throw.
 */
export function formatSubskillLoad(
  skillId: string,
  subskillId: string,
  result: ResolveSubskillResult,
): string {
  if (result.ok) {
    const attachments = formatSkillAttachmentIndex(
      result.subskill.attachments,
      skillId, subskillId,
    );
    return `# Sub-skill: ${result.skillName} › ${result.subskill.name}\n\n${result.subskill.body}`
      + (attachments ? `\n\n${attachments}` : "");
  }
  const list = (ids: string[]) =>
    ids.length > 0 ? ids.map((id) => `\`${id}\``).join(", ") : "(none)";
  switch (result.reason) {
    case "unknown_skill":
      return (
        `No skill with id "${skillId}" is available. ` +
        `Valid skill ids: ${list(result.validSkillIds)}.`
      );
    case "no_subskills":
      return `Skill "${result.skillName}" (${skillId}) has no sub-skills to load.`;
    case "unknown_subskill":
      return (
        `Skill "${result.skillName}" has no sub-skill "${subskillId}". ` +
        `Valid sub-skill ids: ${list(result.validSubskillIds)}.`
      );
  }
}
