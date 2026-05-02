/**
 * Build the prompt argument for `query()` from a {@link StartSessionOptions}.
 *
 * The SDK's `query()` accepts `prompt: string | AsyncIterable<SDKUserMessage>`.
 * When the client supplies binary attachments (today: images) we take the
 * iterable form and yield a single user message whose `content` is an array
 * of content blocks — a text block with the composed prompt followed by one
 * `image` block per attachment. That's the only way the SDK surfaces the
 * image bytes to the model; concatenating a base64 blob into the prompt
 * string would not.
 *
 * When there are no attachments we return the raw string — cheaper, and
 * the generator-backed path adds a fence the older resume/minion flows
 * don't need to cross.
 */
import type { StartSessionOptions } from "./session-host.ts";

/**
 * Minimal shape of the SDK user-turn message used by query()'s iterable
 * prompt path. Defined locally so this file does not import the SDK
 * (only server/harness/claude/ may do that after Phase 4).
 */
interface SDKUserMessage {
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

export function buildQueryPrompt(
  opts: StartSessionOptions,
): string | AsyncIterable<SDKUserMessage> {
  const atts = opts.attachments ?? [];
  if (atts.length === 0) return opts.prompt;

  const message: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text: opts.prompt },
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

  // The SDK only consumes the iterable for its first user turn; we yield
  // once and close, mirroring the string-prompt shape.
  return (async function* promptIterable() {
    yield message;
  })();
}
