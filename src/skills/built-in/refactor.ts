import type { SkillTemplate } from "../types.ts";

export const refactorSkill: SkillTemplate = {
  id: "refactor",
  name: "Refactor",
  description: "Refactor code while preserving behavior.",
  category: "code",
  icon: "♻️",
  accentColor: "#f59e0b",
  template: `# Code Refactoring

Refactor the specified code. **Preserve all existing behavior** — do NOT change functionality.

## Target
{{target}}

## Goal: {{goal}}

## Constraints
{{constraints}}

## Instructions
- Read and understand the existing code before making changes
- Maintain all existing tests — they should still pass
- Make incremental, reviewable changes
- Document any non-obvious decisions with comments
- Run tests after refactoring to verify behavior is preserved`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Files or code to refactor",
      required: true,
    },
    {
      name: "goal",
      label: "Refactoring Goal",
      type: "select",
      defaultValue: "simplify",
      options: [
        { value: "simplify", label: "Simplify" },
        { value: "extract", label: "Extract/Modularize" },
        { value: "modernize", label: "Modernize" },
        { value: "dry", label: "Remove Duplication (DRY)" },
        { value: "performance", label: "Optimize Performance" },
      ],
    },
    {
      name: "constraints",
      label: "Constraints",
      type: "textarea",
      placeholder: "Any constraints or things to preserve (optional)",
    },
  ],
};
