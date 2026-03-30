import type { SkillTemplate } from "../types.ts";

export const commitSkill: SkillTemplate = {
  id: "commit",
  name: "Smart Commit",
  description: "Analyze changes and create well-formatted commits.",
  category: "devops",
  icon: "📦",
  accentColor: "#f472b6",
  template: `# Smart Commit

Analyze the current changes and create a well-formatted commit.

## Convention: {{convention}}
## Scope Hint: {{scope}}

## Instructions
- Run \`git diff\` and \`git diff --staged\` to understand all changes
- Group related changes logically
- Write a clear, descriptive commit message following the {{convention}} convention
- If changes span multiple concerns, consider suggesting multiple commits
- Review the diff carefully before committing — don't commit unintended changes`,
  variables: [
    {
      name: "scope",
      label: "Scope",
      type: "text",
      placeholder: "Scope of changes (optional)",
      description: "Hint about what area the changes affect",
    },
    {
      name: "convention",
      label: "Convention",
      type: "select",
      defaultValue: "conventional",
      options: [
        { value: "conventional", label: "Conventional Commits" },
        { value: "angular", label: "Angular" },
        { value: "freeform", label: "Freeform" },
      ],
    },
  ],
};
