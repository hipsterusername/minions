import type { SkillTemplate } from "../types.ts";

export const testGeneratorSkill: SkillTemplate = {
  id: "test-generator",
  name: "Test Generator",
  description: "Generate comprehensive tests for specified code.",
  category: "testing",
  icon: "🧪",
  accentColor: "#34d399",
  template: `# Test Generation

Generate comprehensive tests for the specified code.

## Target
{{target}}

## Framework: {{framework}}
## Coverage Type: {{coverage}}

## Instructions
- Read the target code carefully before writing tests
- Cover happy paths, edge cases, and error conditions
- Use descriptive test names that explain what's being tested
- Mock external dependencies appropriately
- Aim for meaningful coverage, not just line coverage

## Additional Requirements
{{requirements}}`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Files or functions to test",
      required: true,
    },
    {
      name: "framework",
      label: "Framework",
      type: "select",
      defaultValue: "auto-detect",
      options: [
        { value: "auto-detect", label: "Auto-detect" },
        { value: "vitest", label: "Vitest" },
        { value: "jest", label: "Jest" },
        { value: "mocha", label: "Mocha" },
      ],
    },
    {
      name: "coverage",
      label: "Coverage",
      type: "select",
      defaultValue: "unit",
      options: [
        { value: "unit", label: "Unit Tests" },
        { value: "integration", label: "Integration Tests" },
        { value: "both", label: "Both" },
      ],
    },
    {
      name: "requirements",
      label: "Extra Requirements",
      type: "textarea",
      placeholder: "Any specific testing requirements (optional)",
    },
  ],
};
