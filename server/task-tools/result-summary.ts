export const DETAIL_RESULT_MAX_CHARS = 1500;
export const DETAIL_DESCRIPTION_MAX_CHARS = 800;

function characterCount(text: string): number {
  return Array.from(text).length;
}

export function capTaskTextForSummary(
  text: string,
  maxChars: number,
  fieldName: "result" | "description",
): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;

  return `${chars.slice(0, maxChars).join("")}…[truncated — ${chars.length.toLocaleString("en-US")} chars total; call get_task_status with detail:"full" for the complete ${fieldName}]`;
}

export function taskTextCharCount(text: string): number {
  return characterCount(text);
}
