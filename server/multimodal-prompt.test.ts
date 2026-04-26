/**
 * Regression tests for the multimodal prompt builder.
 *
 * Anchors the bug where an image dropped onto the canvas never reached
 * the model — before this path existed, `query()` was called with a
 * plain string, so only the text description flowed and the model
 * happily hallucinated what the image contained.
 */
import { describe, expect, it } from "vitest";
import { buildQueryPrompt } from "./multimodal-prompt.ts";
import type { StartSessionOptions } from "./session-host.ts";

function baseOpts(over: Partial<StartSessionOptions> = {}): StartSessionOptions {
  return {
    sessionKey: "k",
    prompt: "hello",
    cwd: "/tmp",
    ...over,
  };
}

describe("buildQueryPrompt", () => {
  it("returns the raw string when there are no attachments", () => {
    const out = buildQueryPrompt(baseOpts());
    expect(out).toBe("hello");
  });

  it("returns the raw string when the attachments array is empty", () => {
    const out = buildQueryPrompt(baseOpts({ attachments: [] }));
    expect(out).toBe("hello");
  });

  it("yields one SDKUserMessage with text + image blocks when attachments are present", async () => {
    const out = buildQueryPrompt(
      baseOpts({
        prompt: "what is in this image?",
        attachments: [
          {
            kind: "image",
            mediaType: "image/png",
            data: "AAAAAAAA",
            filename: "cat.png",
          },
        ],
      }),
    );
    expect(typeof out).not.toBe("string");
    const msgs: unknown[] = [];
    for await (const m of out as AsyncIterable<unknown>) msgs.push(m);
    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as {
      type: string;
      message: { role: string; content: unknown[] };
      parent_tool_use_id: null;
      uuid?: string;
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
    const out = buildQueryPrompt(
      baseOpts({
        attachments: [
          { kind: "image", mediaType: "image/png", data: "ONE" },
          { kind: "image", mediaType: "image/jpeg", data: "TWO" },
        ],
      }),
    );
    const iter = out as AsyncIterable<unknown>;
    const firstIt = iter[Symbol.asyncIterator]();
    const { value } = await firstIt.next();
    const content = (value as { message: { content: unknown[] } }).message.content;
    expect(content).toHaveLength(3); // text + 2 images
    expect((content[1] as { source: { data: string } }).source.data).toBe("ONE");
    expect((content[2] as { source: { data: string } }).source.data).toBe("TWO");
  });
});
