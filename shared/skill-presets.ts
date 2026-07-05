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

export const builtInSkillPresets: SkillPreset[] = [
  systemModelAuthoringSkill,
];
