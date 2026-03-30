import type { SkillTemplate } from "../types.ts";

export const simplifySkill: SkillTemplate = {
  id: "simplify",
  name: "Simplify",
  description:
    "Review changed code for reuse, quality, and efficiency, then fix issues found.",
  category: "code",
  icon: "✨",
  accentColor: "#34d399",
  template: `# Simplify & Clean Up

Review recently changed code and fix any issues found directly.

## Target
{{target}}

## Review Depth: {{depth}}

## Instructions
1. **Check git diff** to understand what changed recently
2. **Look for code duplication** — extract shared utilities or helper functions where patterns repeat
3. **Simplify overly complex logic** — flatten nested conditionals, reduce cyclomatic complexity, prefer early returns
4. **Remove dead code** — unused imports, unreachable branches, commented-out blocks, unnecessary abstractions
5. **Ensure clear and consistent naming** — variables, functions, and types should be self-documenting
6. **Fix all issues found directly** — do not just report problems, apply the fixes

## Additional Context
{{notes}}

## Guidelines
- Preserve existing behavior — simplification must not change functionality
- Run any available tests after making changes to verify nothing broke
- Prefer small, focused changes over sweeping rewrites
- When extracting utilities, co-locate them near their usage unless they are broadly reusable`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Files or code to review",
      required: true,
    },
    {
      name: "depth",
      label: "Review Depth",
      type: "select",
      defaultValue: "thorough",
      options: [
        { value: "quick-pass", label: "Quick Pass" },
        { value: "thorough", label: "Thorough" },
        { value: "deep-dive", label: "Deep Dive" },
      ],
    },
    {
      name: "notes",
      label: "Additional Context",
      type: "textarea",
      placeholder: "Any extra context or focus areas (optional)",
    },
  ],
};
