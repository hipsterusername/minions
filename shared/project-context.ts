export const PROJECT_CONTEXT_CHAR_LIMIT = 6000;
export const UNCONFIGURED_PROJECT_CONTEXT_MESSAGE =
  "Project context has not been configured yet.";

export function defaultProjectContext(projectName: string): string {
  return `# ${projectName}\n\n${UNCONFIGURED_PROJECT_CONTEXT_MESSAGE}\n`;
}

export function isProjectContextEmpty(
  context: { content: string; exists: boolean } | null | undefined,
): boolean {
  return !context?.exists || !context.content.trim()
    || context.content.includes(UNCONFIGURED_PROJECT_CONTEXT_MESSAGE);
}
