import type { DisplayMessage } from "../../sdk-messages.ts";

export type LeaderTranscriptMode = "lean" | "full";

export function buildLeaderTranscript(
  messages: DisplayMessage[],
  mode: LeaderTranscriptMode,
): string {
  const blocks = messages.flatMap((message) => {
    const content = message.content.trim();
    if (!content) return [];

    switch (message.role) {
      case "user":
        return [`User:\n${content}`];
      case "assistant":
        return [`Assistant:\n${content}`];
      case "thinking":
        return mode === "full" ? [`Assistant (thinking):\n${content}`] : [];
      default:
        return [];
    }
  });

  return blocks.join("\n\n");
}
