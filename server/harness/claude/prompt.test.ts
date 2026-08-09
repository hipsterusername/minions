/**
 * Tests for the Claude-internal `buildClaudePrompt`. Pins the multimodal first-turn
 * shape so an image dropped onto the canvas reaches the Anthropic SDK
 * as a real `image` content block, not a stringified base64 blob.
 *
 * The function lives inside the Claude harness now; non-Claude harnesses
 * own their own attachment formatting (see `server/harness/codex/attachments.ts`).
 */

import { describe, expect, it } from "vitest";
import { buildClaudePrompt } from "./prompt.ts";
import type {
  HarnessStartOptions,
  NormalizedAttachment,
} from "../types.ts";

function baseOpts(over: Partial<HarnessStartOptions> = {}): HarnessStartOptions {
  return {
    sessionKey: "k",
    cwd: "/tmp",
    prompt: "hello",
    systemPrompt: "",
    model: "claude-sonnet-5",
    allowedTools: [],
    abortSignal: new AbortController().signal,
    ...over,
  };
}

describe("buildClaudePrompt", () => {
  it("returns the raw string when there are no attachments", async () => {
    const out = await buildClaudePrompt(baseOpts());
    expect(out).toBe("hello");
  });

  it("returns the raw string when the attachments array is empty", async () => {
    const out = await buildClaudePrompt(baseOpts({ attachments: [] }));
    expect(out).toBe("hello");
  });

  it("yields one SDKUserMessage with text + image blocks when attachments are present", async () => {
    const att: NormalizedAttachment = {
      kind: "image",
      mediaType: "image/png",
      data: "AAAAAAAA",
      filename: "cat.png",
    };
    const out = await buildClaudePrompt(
      baseOpts({ prompt: "what is in this image?", attachments: [att] }),
    );
    expect(typeof out).not.toBe("string");
    const msgs: unknown[] = [];
    for await (const m of out as AsyncIterable<unknown>) msgs.push(m);
    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as {
      type: string;
      message: { role: string; content: unknown[] };
      parent_tool_use_id: null;
    };
    expect(msg.type).toBe("user");
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.message.role).toBe("user");
    expect(msg.message.content).toEqual([
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAAAAAA" },
      },
    ]);
  });

  it("emits one image block per attachment, preserving order", async () => {
    const out = await buildClaudePrompt(
      baseOpts({
        attachments: [
          { kind: "image", mediaType: "image/png", data: "ONE" },
          { kind: "image", mediaType: "image/jpeg", data: "TWO" },
        ],
      }),
    );
    const iter = out as AsyncIterable<unknown>;
    const it1 = iter[Symbol.asyncIterator]();
    const { value } = await it1.next();
    const content = (value as { message: { content: unknown[] } }).message.content;
    expect(content).toHaveLength(3);
    expect((content[1] as { source: { data: string } }).source.data).toBe("ONE");
    expect((content[2] as { source: { data: string } }).source.data).toBe("TWO");
  });
});
