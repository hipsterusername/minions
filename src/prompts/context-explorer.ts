import { PROJECT_CONTEXT_CHAR_LIMIT } from "../../shared/project-context.ts";
export const CONTEXT_EXPLORER_PROMPT = (projectPath: string) => `Explore the project at ${projectPath} and populate its Minions project context.

Your goal is to understand this project and save concise context that will help subsequently delegated Minion agents work effectively in this codebase.

## What to investigate

1. **Project purpose** — What does this project do? Read the README, package.json, or entry points.
2. **Tech stack** — Languages, frameworks, build tools, key dependencies.
3. **Architecture** — How is the code organized? Key directories and their roles.
4. **Key abstractions** — Important types, classes, patterns, and conventions.
5. **Entry points** — Where does execution start? Main files, API routes, CLI commands.
6. **Development workflow** — How to build, test, run, deploy.
7. **Current state** — What's working, what's in progress, any known issues.

## Save the result

After investigating, call \`update_project_context\` exactly once with the complete context as well-structured Markdown. Use headers, bullet points, and code references. Be specific — reference actual file paths, function names, and type names.

Do not create or edit \`context.md\`, \`CLAUDE.md\`, or another repository file. Those files do not populate the Minions Context panel; only \`update_project_context\` fulfills this task.

## Important

- Read actual source files, don't guess
- If you're unsure about something, note it as uncertain
- Focus on what's useful for someone about to work in this codebase
- Keep it concise but complete — keep the complete document within ${PROJECT_CONTEXT_CHAR_LIMIT} characters (the delegated prompt budget). Prioritize current constraints, build/test commands, key entry points and exact reference paths; remove repeated background

Begin by exploring the project structure and key files.`;
