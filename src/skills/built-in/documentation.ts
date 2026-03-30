import type { SkillTemplate } from "../types.ts";

export const documentationSkill: SkillTemplate = {
  id: "documentation",
  name: "Documentation",
  description: "Generate documentation for code or projects.",
  category: "docs",
  icon: "📝",
  accentColor: "#a78bfa",
  template: `# Documentation Generation

Generate {{format}} documentation for the specified code.

## Target
{{target}}

## Audience: {{audience}}

## Instructions
- Read the code thoroughly before documenting
- Include examples where helpful
- Document public APIs, parameters, return values, and side effects
- Note any gotchas, limitations, or important design decisions
- Keep the tone appropriate for the target audience

## Additional Context
{{context}}`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Files or functions to document",
      required: true,
    },
    {
      name: "format",
      label: "Format",
      type: "select",
      defaultValue: "markdown",
      options: [
        { value: "jsdoc", label: "JSDoc/TSDoc" },
        { value: "markdown", label: "Markdown" },
        { value: "readme", label: "README" },
        { value: "api-reference", label: "API Reference" },
      ],
    },
    {
      name: "audience",
      label: "Audience",
      type: "select",
      defaultValue: "developers",
      options: [
        { value: "developers", label: "Developers" },
        { value: "users", label: "End Users" },
        { value: "both", label: "Both" },
      ],
    },
    {
      name: "context",
      label: "Additional Context",
      type: "textarea",
      placeholder: "Extra context about the project (optional)",
    },
  ],
};
