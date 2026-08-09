export interface SkillPresetVariable {
  name: string;
  label: string;
  type: "text" | "textarea" | "select";
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  description?: string;
}

/**
 * Sub-skill preset — mirror of `SubSkill` (hand-copied across type trees
 * because cross-tree imports are banned by the architecture suite).
 */
export interface SubSkillPreset {
  id: string;
  name: string;
  description: string;
  body: string;
  whenToUse?: string;
  alwaysInclude?: boolean;
}

export interface SkillPreset {
  id: string;
  name: string;
  description: string;
  category:
    | "code"
    | "docs"
    | "testing"
    | "devops"
    | "analysis"
    | "design"
    | "general";
  icon: string;
  accentColor: string;
  template: string;
  variables: SkillPresetVariable[];
  subskills?: SubSkillPreset[];
}

export const systemModelAuthoringSkill: SkillPreset = {
  id: "system-model-authoring",
  name: "System Model Authoring",
  description:
    "Author compact .systemmodel objects that describe user-facing capabilities, flows, constraints, decisions, policies, and risks.",
  category: "analysis",
  icon: "SM",
  accentColor: "#0f766e",
  template: `# System Model Authoring

Author or update repo-side files under .systemmodel/. The model is human-authored context for future agents, not a generated code graph.

## Object Discipline
- Capabilities are user-facing powers, not modules. Prefer "approve isolated worktree changes" over "worktree.ts".
- Create an object only if it will change agent behavior: better scoping, stronger constraints, clearer review gates, or fewer missed risks.
- Prefer editing an existing object over adding a near-duplicate.
- Every capability, flow, constraint, risk, and policy must include suggested_files or file globs through its schema where available. Globs must actually match the repo.
- Keep summaries short and operational. Do not restate file lists as prose.

## Repo Format
.systemmodel/manifest.yaml
.systemmodel/capabilities/*.yaml
.systemmodel/flows/*.yaml
.systemmodel/constraints/*.yaml
.systemmodel/decisions/ADR-*.md
.systemmodel/risks.yaml
.systemmodel/policies/freshness.yaml
.systemmodel/policies/review-gates.yaml
.systemmodel/policies/context-budgets.yaml

Use snake_case YAML keys, matching the loader fixtures.

## Schemas Summary
Capability YAML:
- id: capability.<stable_slug>
- type: capability
- name, summary
- linked_flows, constraints, decisions, risks
- suggested_files, suggested_tests, keywords
- freshness.class: code_coupled | policy | informational
- risk: low | medium | high | critical

Flow YAML:
- id: flow.<stable_slug>
- type: flow
- name, summary
- capabilities, constraints, decisions, risks
- suggested_files, suggested_tests, steps
- freshness.class and risk

Constraint YAML:
- id: constraint.<stable_slug>
- type: constraint
- statement
- applies_to.capabilities, applies_to.flows, applies_to.files
- severity: low | medium | high | critical
- agent_instruction, review_gate, suggested_tests, evidence

Decision Markdown:
- file: decisions/ADR-*.md
- YAML front matter: id: decision.<stable_slug>, type: decision, status, summary
- Body explains the accepted architectural decision and consequences.

Risks YAML:
- risks: array of risk objects
- each risk has id: risk.<stable_slug>, type: risk, summary, severity
- applies_to.capabilities, applies_to.flows, applies_to.files
- mitigation

Policies:
- freshness.yaml: freshness entries with policy_class, consequence, required_actions
- review-gates.yaml: review_gates entries with id: gate.<slug>, name, description, blocks_merge, required_when.files/capabilities/flows/risk
- context-budgets.yaml: context_budgets.leader_prompt_addendum, minion_context_pack, per_object_summary

## Authoring Process
1. Read README.md, CLAUDE.md, docs/testing-strategy.md, and the relevant entry points before writing.
2. Identify 6-10 real capabilities as powers users rely on.
3. Add 3-4 high-value flows that cross capability boundaries.
4. Encode architectural invariants as constraints with review gates where violating them should block or warn.
5. Add only decisions and risks that future agents should see before editing.
6. Run pnpm system-model:validate and fix every error.`,
  variables: [],
};

export const skillBuilderSkill: SkillPreset = {
  id: "skill-builder",
  name: "Skill Builder",
  description:
    "Author reusable Minions skills — design the template, variables, and sub-skills, then persist them with the skill-authoring tools (create_skill, update_skill, list_skills, get_skill, delete_skill).",
  category: "general",
  icon: "SB",
  accentColor: "#7c3aed",
  template: `# Skill Builder

You are acting as a skill author for this Minions project. Your job is to turn a
capability request into a well-formed, reusable **skill** and persist it to the
project's skill library. A skill is a Markdown instruction template that the
Leader can later "arm" a Minion with; its compiled body is appended to that
agent's system prompt.

## Tools you have
You have a dedicated set of skill-authoring tools (MCP prefix \`mcp__skills__\`):
- \`list_skills\` — see what already exists (id, name, description, category, source). Do this FIRST so you extend rather than duplicate.
- \`get_skill\` — read a full skill (template, variables, sub-skills) before editing it.
- \`create_skill\` — persist a new skill. Provide at minimum \`name\` and \`template\`; the id is derived from the name unless you pass one.
- \`update_skill\` — patch an existing skill by \`id\`. Unspecified fields are preserved; editing a built-in creates a project override.
- \`delete_skill\` — remove a project skill by \`id\`. Built-in presets cannot be deleted, only overridden.

## Anatomy of a good skill
- **name** — short, capability-oriented (e.g. "API Contract Reviewer"), not a file name.
- **description** — one line an agent reads to decide whether to use it. State the outcome and the trigger.
- **category** — one of: code, docs, testing, devops, analysis, design, general.
- **template** — the instruction body in Markdown. Write it as a direct playbook: what to read first, the step-by-step process, the invariants to hold, and the definition of done. Prefer imperative, checkable steps over prose.
- **variables** — declare a \`{{placeholder}}\` for anything that changes per use (target path, ticket id, style guide). Any \`{{placeholder}}\` you leave undeclared is auto-added as a plain text variable, so only declare the ones that need a label, select options, or help text.
- **sub-skills** (optional) — when a skill is large, split rarely-needed detail into sub-skills. The parent injects only a compact *map*; the agent pulls a body on demand with \`load_subskill\`. Use \`alwaysInclude\` only for content every run needs.

## Authoring process
1. Restate the requested capability in one sentence. If it is vague, narrow it to something observable.
2. Call \`list_skills\` and, if a close match exists, \`get_skill\` it — prefer \`update_skill\` over creating a near-duplicate.
3. Draft the template: read-first pointers → numbered process → constraints → definition of done. Keep it tight; every line costs the armed agent context budget.
4. Factor variables. Name them in \`snake_case\`. Give required inputs a clear label and, where the choice is closed, \`select\` options.
5. If the body exceeds a few hundred words, move optional depth into sub-skills and leave a map.
6. Persist with \`create_skill\` (or \`update_skill\`). Then \`get_skill\` the result to confirm the id, variables, and body compiled as intended.
7. Report the new skill's id so the Leader can arm a Minion with it via \`assign_task\`'s \`skillIds\`.

## Quality bar
- Replace, don't accumulate: fix an existing skill rather than shipping v2 alongside v1.
- A skill should read like an expert's checklist, not a description of a checklist.
- Never invent tool names or repo conventions inside a template — describe process, not fictional APIs.`,
  variables: [],
};

export const builtInSkillPresets: SkillPreset[] = [
  systemModelAuthoringSkill,
  skillBuilderSkill,
];
