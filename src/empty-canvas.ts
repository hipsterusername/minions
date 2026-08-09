const MIN_EMPTY_CANVAS_DESCRIPTION_LENGTH = 12;

export function isValidEmptyCanvasDescription(description: string): boolean {
  return description.trim().length >= MIN_EMPTY_CANVAS_DESCRIPTION_LENGTH;
}

export function buildEmptyCanvasLeaderPrompt(description: string): string {
  const normalizedDescription = description.trim().replace(/\r\n/g, "\n");

  return [
    "The user is starting from an empty canvas and provided this context description:",
    `<context-description>\n${normalizedDescription}\n</context-description>`,
    [
      "Use this description to bootstrap the workspace.",
      "First, call render_set with a concise dashboard that shows the interpreted context, any missing information, and the immediate plan.",
      "If the description is not complete enough to proceed, ask only for the missing context; prefer a dashboard form when structured answers would be clearer than free text.",
      "Once the context is complete and the work is finished or blocked, refresh the dashboard with render_set so it shows the final state, results, blockers, and next actions.",
    ].join(" "),
  ].join("\n\n");
}
