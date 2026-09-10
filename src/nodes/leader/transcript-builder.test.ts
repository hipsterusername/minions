import { describe, it, expect } from "vitest";
import {
  buildLeaderTranscript,
  buildLeaderTranscriptBlocks,
  TRANSCRIPT_BLOCK_SEPARATOR,
  type LeaderTranscriptMode,
} from "./transcript-builder.ts";
import type { DisplayMessage } from "../../sdk-messages.ts";
import { buildSessionContext } from "./session-context.ts";

function message(
  role: DisplayMessage["role"],
  content: string,
  id = `${role}-${content}`,
): DisplayMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
  };
}

describe("buildLeaderTranscript", () => {
  it("excludes saved archive placeholders from all prompt paths while preserving user discussion", () => {
    const link = "[Read archived event (16384 bytes)](/api/history/run-00000000-0000-4000-8000-000000000001/events/42)";
    const preview = "[Archive preview] Archived event (12891 bytes). [Download exact event JSON](/api/history/s/events/1)\n\nRAW_TOOL_OUTPUT";
    const messages = [message("user", "Continue the work"), message("assistant", "Useful conclusion"),
      message("assistant", link), message("result", link), message("system", link),
      message("assistant", preview), message("thinking", link)];
    for (const text of [buildLeaderTranscript(messages, "lean"), buildLeaderTranscript(messages, "full"), buildSessionContext(messages)]) {
      expect(text).toContain("Useful conclusion");
      expect(text).not.toContain("/api/history/");
      expect(text).not.toContain("RAW_TOOL_OUTPUT");
    }
    expect(buildLeaderTranscript([message("user", link)], "lean")).toContain(link);
    expect(buildSessionContext([message("user", link)])).toContain(link);
    expect(buildLeaderTranscript([message("assistant", `Investigating this placeholder: ${link}`)], "lean")).toContain("Investigating");
  });
  it("in lean mode includes user and assistant messages but excludes thinking and tool messages", () => {
    const transcript = buildLeaderTranscript([
      message("user", "Start here"),
      message("thinking", "Hidden reasoning"),
      message("assistant", "Working on it"),
      message("tool", "read file"),
    ], "lean");

    expect(transcript).toBe("User:\nStart here\n\nAssistant:\nWorking on it");
  });

  it("in full mode includes user, assistant, and thinking messages but excludes tool messages", () => {
    const transcript = buildLeaderTranscript([
      message("user", "Start here"),
      message("thinking", "Consider edge cases"),
      message("assistant", "Done"),
      message("tool", "read file"),
    ], "full");

    expect(transcript).toBe(
      "User:\nStart here\n\nAssistant (thinking):\nConsider edge cases\n\nAssistant:\nDone",
    );
  });

  it("skips messages with empty or whitespace-only content", () => {
    const transcript = buildLeaderTranscript([
      message("user", "   "),
      message("assistant", "\n\n"),
      message("thinking", "\t"),
      message("user", "  useful content  "),
    ], "full");

    expect(transcript).toBe("User:\nuseful content");
  });

  it("returns an empty string when no messages are kept", () => {
    const modes: LeaderTranscriptMode[] = ["lean", "full"];

    for (const mode of modes) {
      expect(buildLeaderTranscript([
        message("tool", "tool call"),
        message("system", "system note"),
        message("result", "result text"),
      ], mode)).toBe("");
    }
  });

});

describe("buildLeaderTranscriptBlocks", () => {
  it("produces one block per forwardable message, in order", () => {
    const blocks = buildLeaderTranscriptBlocks([
      message("user", "Question"),
      message("tool", "read file"),
      message("assistant", "Answer"),
    ], "lean");

    expect(blocks).toEqual(["User:\nQuestion", "Assistant:\nAnswer"]);
  });

  it("joined blocks equal the full transcript (append-watermark invariant)", () => {
    // context-delivery.ts validates append watermarks by hashing
    // blocks.join(TRANSCRIPT_BLOCK_SEPARATOR); this invariant is load-bearing.
    const messages = [
      message("user", "Question"),
      message("thinking", "Reasoning"),
      message("assistant", "Answer"),
    ];
    for (const mode of ["lean", "full"] as LeaderTranscriptMode[]) {
      expect(
        buildLeaderTranscriptBlocks(messages, mode).join(TRANSCRIPT_BLOCK_SEPARATOR),
      ).toBe(buildLeaderTranscript(messages, mode));
    }
  });

  it("is append-only as messages grow: earlier blocks are unchanged", () => {
    const earlier = [message("user", "one"), message("assistant", "two")];
    const later = [...earlier, message("user", "three")];
    const before = buildLeaderTranscriptBlocks(earlier, "lean");
    const after = buildLeaderTranscriptBlocks(later, "lean");
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });
});
