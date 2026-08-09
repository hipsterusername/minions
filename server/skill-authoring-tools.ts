/**
 * Skill-authoring MCP tools.
 *
 * These back the built-in `skill-builder` skill: an agent armed with it uses
 * them to design and persist reusable skills into central workspace
 * `skills.json`. Exposed to both the leader and minions under the
 * `skills` tool group, so tool calls follow the `mcp__skills__*` pattern.
 *
 * Persistence goes through `readSkills`/`writeSkills` (the same central state the
 * frontend SkillsBrowser reads/writes); the pure validation and array helpers
 * live in `./skill-authoring.ts`. Built-in presets are merged in for reads but
 * cannot be mutated on disk — editing one writes a project override.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "./harness/types.ts";
import { jsonResult, textResult, errorResult } from "./harness/tool-result.ts";
import { readSkills, writeSkills } from "./project-store.ts";
import { loadAllSkills } from "./skills.ts";
import {
  SKILL_CATEGORIES,
  buildSkillDraft,
  isRawSkill,
  removeSkillFromArray,
  summarizeSkillLibrary,
  upsertSkillInArray,
  type SkillDraftInput,
} from "./skill-authoring.ts";

const variableSchema = z.object({
  name: z.string().describe("Placeholder name as it appears in {{name}}."),
  label: z.string().describe("Human-readable label for the input field."),
  type: z.enum(["text", "textarea", "select"]).default("text"),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  defaultValue: z.string().optional(),
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional()
    .describe("Choices for a select variable."),
  description: z.string().optional().describe("Help text shown below the input."),
});

const subskillSchema = z.object({
  id: z.string().optional().describe("Stable id; derived from name when omitted."),
  name: z.string(),
  description: z.string().describe("One-line summary shown in the sub-skill map."),
  body: z.string().describe("Full sub-skill content, pulled on demand."),
  whenToUse: z.string().optional().describe("Trigger hint shown in the map."),
  alwaysInclude: z
    .boolean()
    .optional()
    .describe("Eager-inline the body into the parent prompt instead of on demand."),
});

const createInputSchema = z.object({
  name: z.string().describe("Short, capability-oriented display name."),
  template: z
    .string()
    .describe("The Markdown instruction body. Use {{placeholders}} for variables."),
  description: z
    .string()
    .optional()
    .describe("One line an agent reads to decide whether to use the skill."),
  category: z.enum(SKILL_CATEGORIES).optional(),
  icon: z.string().optional().describe("Short 1-2 char badge, e.g. 'SB'."),
  accentColor: z.string().optional().describe("Hex accent color, e.g. '#7c3aed'."),
  id: z
    .string()
    .optional()
    .describe("Explicit id; derived from the name when omitted."),
  variables: z.array(variableSchema).optional(),
  subskills: z.array(subskillSchema).optional(),
});

const updateInputSchema = createInputSchema
  .partial()
  .extend({ id: z.string().describe("Id of the skill to update.") });

const getInputSchema = z.object({
  id: z.string().describe("Id of the skill to read (built-in or project)."),
});

const deleteInputSchema = z.object({
  id: z.string().describe("Id of the project skill to delete."),
});

export function createSkillAuthoringTools(opts: {
  projectPath: string;
}): NormalizedToolDef[] {
  const { projectPath } = opts;

  const listSkills: NormalizedToolDef = {
    name: "list_skills",
    description:
      "List every skill in the project's library (built-in + project), with id, " +
      "name, description, category, source, and variable/sub-skill counts. Call " +
      "this before authoring so you extend or edit rather than duplicate.",
    inputSchema: z.object({}),
    handler: async () => jsonResult(summarizeSkillLibrary(readSkills(projectPath))),
  };

  const getSkill: NormalizedToolDef = {
    name: "get_skill",
    description:
      "Read a full skill by id — template, variables, and sub-skills — before " +
      "editing it. Resolves built-in presets and project skills alike.",
    inputSchema: getInputSchema,
    handler: async (input: unknown) => {
      const { id } = getInputSchema.parse(input);
      const skill = loadAllSkills(projectPath).find((s) => s.id === id);
      if (!skill) {
        return errorResult(
          `No skill with id "${id}". Call list_skills to see valid ids.`,
        );
      }
      return jsonResult(skill);
    },
  };

  const persistDraft = (
    input: SkillDraftInput,
    base: Parameters<typeof buildSkillDraft>[1],
  ) => {
    const built = buildSkillDraft(input, base);
    if (!built.ok) return errorResult(built.error);
    const { next, created } = upsertSkillInArray(
      readSkills(projectPath),
      built.skill,
    );
    writeSkills(projectPath, next);
    const verb = created ? "Created" : "Updated";
    return textResult(
      `${verb} skill "${built.skill.name}" (id: ${built.skill.id}) with ` +
        `${built.skill.variables.length} variable(s)` +
        `${built.skill.subskills ? ` and ${built.skill.subskills.length} sub-skill(s)` : ""}. ` +
        `Arm a Minion with it via assign_task skillIds: ["${built.skill.id}"].`,
    );
  };

  const createSkill: NormalizedToolDef = {
    name: "create_skill",
    description:
      "Create and persist a new skill to the project library. Provide at least " +
      "a name and a template; the id is derived from the name unless given. " +
      "Undeclared {{placeholders}} in the template are auto-added as text " +
      "variables. Fails if a project skill with the resolved id already exists " +
      "— use update_skill to modify it.",
    inputSchema: createInputSchema,
    handler: async (input: unknown) => {
      const parsed = createInputSchema.parse(input);
      const built = buildSkillDraft(parsed);
      if (!built.ok) return errorResult(built.error);
      const existing = readSkills(projectPath);
      if (existing.some((e) => isRawSkill(e) && e.id === built.skill.id)) {
        return errorResult(
          `A project skill with id "${built.skill.id}" already exists. ` +
            `Use update_skill to modify it, or pass a different name/id.`,
        );
      }
      return persistDraft(parsed, undefined);
    },
  };

  const updateSkill: NormalizedToolDef = {
    name: "update_skill",
    description:
      "Update an existing skill by id. Unspecified fields are preserved. " +
      "Editing a built-in preset writes a project override with the same id.",
    inputSchema: updateInputSchema,
    handler: async (input: unknown) => {
      const parsed = updateInputSchema.parse(input);
      const base = loadAllSkills(projectPath).find((s) => s.id === parsed.id);
      if (!base) {
        return errorResult(
          `No skill with id "${parsed.id}". Call list_skills to see valid ids.`,
        );
      }
      return persistDraft(parsed, base);
    },
  };

  const deleteSkill: NormalizedToolDef = {
    name: "delete_skill",
    description:
      "Delete a project skill by id. Built-in presets cannot be deleted (only " +
      "overridden via update_skill); deleting an override restores the built-in.",
    inputSchema: deleteInputSchema,
    handler: async (input: unknown) => {
      const { id } = deleteInputSchema.parse(input);
      const { next, removed } = removeSkillFromArray(readSkills(projectPath), id);
      if (!removed) {
        return errorResult(
          `No project skill with id "${id}" to delete. Built-in presets are not ` +
            `deletable; call list_skills to see project skills.`,
        );
      }
      writeSkills(projectPath, next);
      return textResult(`Deleted project skill "${id}".`);
    },
  };

  return [listSkills, getSkill, createSkill, updateSkill, deleteSkill];
}
