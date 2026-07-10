import type { DisplayMessage } from "../../sdk-messages.ts";

export type LeaderTranscriptMode = "lean" | "full";

/** Separator between transcript blocks. Shared with the context-delivery
 *  suffix-diff logic: `blocks.join(TRANSCRIPT_BLOCK_SEPARATOR)` must equal the
 *  full transcript so append watermarks can be validated by prefix hash. */
export const TRANSCRIPT_BLOCK_SEPARATOR = "\n\n";

/**
 * Build the transcript as an ordered list of blocks (one per forwardable
 * message). The list is append-only as the session progresses, which is what
 * lets connected-context delivery send only the suffix of new blocks
 * (`src/context-delivery.ts`) instead of re-sending the whole transcript.
 */
export function buildLeaderTranscriptBlocks(
  messages: DisplayMessage[],
  mode: LeaderTranscriptMode,
): string[] {
  return messages.flatMap((message) => {
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
}

export function buildLeaderTranscript(
  messages: DisplayMessage[],
  mode: LeaderTranscriptMode,
): string {
  return buildLeaderTranscriptBlocks(messages, mode).join(
    TRANSCRIPT_BLOCK_SEPARATOR,
  );
}
