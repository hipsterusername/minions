import type { SkillTemplate } from "../types.ts";

export const explainSkill: SkillTemplate = {
  id: "explain",
  name: "Explain Code",
  description: "Get clear explanations of code or concepts.",
  category: "analysis",
  icon: "💡",
  accentColor: "#06b6d4",
  template: `# Code Explanation

Provide a {{depth}} explanation of the specified code or concept, suitable for a {{audience}} audience.

## Target
{{target}}

## Instructions
- Read and understand the code before explaining
- Use concrete examples and analogies where helpful
- Explain the "why" behind design decisions, not just the "what"
- For complex systems, start with a high-level overview before diving into details
- Highlight any non-obvious patterns, idioms, or gotchas

## Specific Questions
{{questions}}`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "File path, function, or concept to explain",
      required: true,
    },
    {
      name: "depth",
      label: "Depth",
      type: "select",
      defaultValue: "detailed",
      options: [
        { value: "overview", label: "Overview" },
        { value: "detailed", label: "Detailed" },
        { value: "deep-dive", label: "Deep Dive" },
      ],
    },
    {
      name: "audience",
      label: "Audience",
      type: "select",
      defaultValue: "intermediate",
      options: [
        { value: "beginner", label: "Beginner" },
        { value: "intermediate", label: "Intermediate" },
        { value: "expert", label: "Expert" },
      ],
    },
    {
      name: "questions",
      label: "Specific Questions",
      type: "textarea",
      placeholder: "Any specific questions to answer (optional)",
    },
  ],
};
