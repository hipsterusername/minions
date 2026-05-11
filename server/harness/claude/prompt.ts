/**
 * Claude-side prompt formatting.
 *
 * Builds the `prompt` argument for `@anthropic-ai/claude-agent-sdk`'s `query()`
 * from a normalized `HarnessStartOptions`. When `attachments` is empty the raw
 * string is handed through unchanged; otherwise the multimodal first turn is
 * yielded as a single `SDKUserMessage` whose `content` is `[text, ...image]`.
 * Concatenating base64 into the prompt string would not surface the image
 * bytes to the model — the iterable form is the only path that does.
 *
 * Moved out of the shared `server/multimodal-prompt.ts` so the Claude SDK
 * message shape stops leaking through code that other harnesses also touch.
 */

import type { HarnessStartOptions } from "../types.ts";

/**
 * Minimal shape of the SDK user-turn message used by `query()`'s iterable
 * prompt path. Defined locally so we don't take a deeper dependency on the
 * SDK type tree just for the multimodal first turn.
 */
export interface SDKUserMessage {
  type: "user";
  parent_tool_use_id: null;
  message: { role: "user"; content: unknown[] };
  uuid: string;
}

/** UUID v4 — lightweight, avoids dragging in `crypto.randomUUID` polyfills. */
function uuid(): string {
  // eslint-disable-next-line no-bitwise -- standard uuidv4 bit twiddling
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Collect an async-iterable of user messages into a single string. */
async function collectPrompt(
  iter: AsyncIterable<{ role: "user"; content: string }>,
): Promise<string> {
  const parts: string[] = [];
  for await (const msg of iter) {
    parts.push(msg.content);
  }
  return parts.join("\n");
}

/**
 * Build the prompt argument for the Claude SDK's `query()`. Returns a string
 * when there are no attachments (cheap path); otherwise an `AsyncIterable`
 * yielding a single multimodal `SDKUserMessage`.
 */
export async function buildClaudePrompt(
  opts: HarnessStartOptions,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  const atts = opts.attachments ?? [];
  if (atts.length === 0) {
    return typeof opts.prompt === "string" ? opts.prompt : collectPrompt(opts.prompt);
  }

  const text =
    typeof opts.prompt === "string" ? opts.prompt : await collectPrompt(opts.prompt);
  const message: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...atts.map((att) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: att.mediaType,
            data: att.data,
          },
        })),
      ],
    },
    uuid: uuid(),
  };

  return (async function* promptIterable() {
    yield message;
  })();
}
