export const CONTEXT_EXPLORER_PROMPT = (projectPath: string) => `Explore the project at ${projectPath} and generate a comprehensive context document.

Your goal is to understand this project and produce a context.md that would help any developer or AI agent work effectively in this codebase.

## What to investigate

1. **Project purpose** — What does this project do? Read the README, package.json, or entry points.
2. **Tech stack** — Languages, frameworks, build tools, key dependencies.
3. **Architecture** — How is the code organized? Key directories and their roles.
4. **Key abstractions** — Important types, classes, patterns, and conventions.
5. **Entry points** — Where does execution start? Main files, API routes, CLI commands.
6. **Development workflow** — How to build, test, run, deploy.
7. **Current state** — What's working, what's in progress, any known issues.

## Output format

Write the context as a well-structured markdown document. Use headers, bullet points, and code references. Be specific — reference actual file paths, function names, and type names.

## Important

- Read actual source files, don't guess
- If you're unsure about something, note it as uncertain
- Focus on what's useful for someone about to work in this codebase
- Keep it concise but complete — aim for a document someone can read in 5 minutes

Begin by exploring the project structure and key files.`;
