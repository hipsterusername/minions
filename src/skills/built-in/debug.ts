import type { SkillTemplate } from "../types.ts";

export const debugSkill: SkillTemplate = {
  id: "debug",
  name: "Debug",
  description: "Systematically analyze and fix bugs.",
  category: "analysis",
  icon: "🐛",
  accentColor: "#ef4444",
  template: `# Bug Investigation & Fix

Systematically investigate and fix the reported issue.

## Issue Description
{{issue}}

## Steps to Reproduce
{{reproduce}}

## Error Logs / Stack Trace
{{logs}}

## Instructions
- Reproduce the issue first if possible
- Read relevant source files and trace the execution path
- Identify the root cause, not just symptoms
- Implement a fix that addresses the root cause
- Verify the fix resolves the issue
- Check for related issues that might have the same root cause`,
  variables: [
    {
      name: "issue",
      label: "Issue",
      type: "textarea",
      placeholder: "Describe the bug or error",
      required: true,
    },
    {
      name: "reproduce",
      label: "Reproduction Steps",
      type: "textarea",
      placeholder: "Steps to reproduce (optional)",
    },
    {
      name: "logs",
      label: "Error Logs",
      type: "textarea",
      placeholder: "Paste error logs or stack trace (optional)",
    },
  ],
};
