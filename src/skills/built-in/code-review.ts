import type { SkillTemplate } from "../types.ts";

export const codeReviewSkill: SkillTemplate = {
  id: "code-review",
  name: "Code Review",
  description: "Analyze code for issues, vulnerabilities, and improvements.",
  category: "code",
  icon: "🔍",
  accentColor: "#60a5fa",
  template: `# Code Review

You are performing a focused code review.

## Target
{{target}}

## Focus Area: {{focus}}

## Instructions
- Use Read, Glob, and Grep to examine the target code thoroughly
- Provide specific, actionable feedback with exact file paths and line numbers
- Categorize each finding by severity: **critical**, **warning**, **suggestion**
- Explain *why* each issue matters, not just what is wrong
- End with a brief summary of overall code health

## Severity Filter: {{severity}}
{{#severity:critical-only}}Only report critical issues — bugs, security vulnerabilities, or data loss risks.{{/severity:critical-only}}
{{#severity:all}}Report all issues from minor style suggestions to critical bugs.{{/severity:all}}

## Additional Notes
{{notes}}`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Files, directories, or describe what to review",
      required: true,
    },
    {
      name: "focus",
      label: "Focus Area",
      type: "select",
      defaultValue: "general",
      options: [
        { value: "general", label: "General" },
        { value: "security", label: "Security" },
        { value: "performance", label: "Performance" },
        { value: "readability", label: "Readability" },
      ],
    },
    {
      name: "severity",
      label: "Severity",
      type: "select",
      defaultValue: "all",
      options: [
        { value: "all", label: "All Issues" },
        { value: "critical-only", label: "Critical Only" },
      ],
    },
    {
      name: "notes",
      label: "Additional Notes",
      type: "textarea",
      placeholder: "Any extra context or constraints (optional)",
    },
  ],
};
