import type { SkillTemplate } from "../types.ts";

export const architectSkill: SkillTemplate = {
  id: "architect",
  name: "Architect",
  description:
    "Design system architecture, plan implementations, and evaluate trade-offs.",
  category: "design",
  icon: "🏗️",
  accentColor: "#818cf8",
  template: `# System Architecture

Design the architecture for the described goal. Produce a clear, actionable plan.

## Goal
{{goal}}

## Scope: {{scope}}

## Priority: {{priorities}}

## Constraints
{{constraints}}

## Additional Context
{{notes}}

## Instructions
- Analyze the existing codebase structure before proposing changes
- Design clean, modular architectures with clear boundaries
- Consider scalability, maintainability, and testability
- Identify appropriate design patterns for the problem domain
- Plan migration paths from current state to proposed architecture
- Document key decisions and the trade-offs behind them
- Create implementation plans with clear ordering and dependencies
- Break the plan into phases with concrete deliverables
- Call out risks and open questions that need resolution`,
  variables: [
    {
      name: "goal",
      label: "Goal",
      type: "textarea",
      placeholder: "What system or feature to architect",
      required: true,
    },
    {
      name: "scope",
      label: "Scope",
      type: "select",
      defaultValue: "greenfield",
      options: [
        { value: "greenfield", label: "Greenfield" },
        { value: "refactor-existing", label: "Refactor Existing" },
        { value: "extend-existing", label: "Extend Existing" },
      ],
    },
    {
      name: "priorities",
      label: "Priorities",
      type: "select",
      defaultValue: "maintainability",
      options: [
        { value: "maintainability", label: "Maintainability" },
        { value: "performance", label: "Performance" },
        { value: "simplicity", label: "Simplicity" },
        { value: "scalability", label: "Scalability" },
      ],
    },
    {
      name: "constraints",
      label: "Constraints",
      type: "textarea",
      placeholder: "Technical constraints, team size, timeline (optional)",
    },
    {
      name: "notes",
      label: "Additional Notes",
      type: "textarea",
      placeholder: "Additional context or requirements (optional)",
    },
  ],
};
