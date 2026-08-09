/**
 * WS attachment validation. Shared by `create_session` and `send_message`
 * so both paths drop malformed image payloads before they reach the SDK.
 */
import type { ImageAttachment } from "../session-host.ts";
import type { WsImageAttachment } from "./types.ts";

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Accept only well-formed image attachments. Anything else is dropped —
 * the text prompt is already on its way, so loudly failing here would be
 * more confusing than silently omitting a bad payload.
 */
export function sanitizeAttachments(raw: unknown): ImageAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const clean: ImageAttachment[] = [];
  for (const item of raw as WsImageAttachment[]) {
    if (!item || item.kind !== "image") continue;
    if (typeof item.data !== "string" || item.data.length === 0) continue;
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(item.mediaType)) continue;
    const att: ImageAttachment = {
      kind: "image",
      mediaType: item.mediaType,
      data: item.data,
    };
    if (typeof item.filename === "string" && item.filename.length > 0) {
      att.filename = item.filename;
    }
    clean.push(att);
  }
  return clean.length > 0 ? clean : undefined;
}
