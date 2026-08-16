import { z } from "zod/v4";

const MAX_CANVAS_ITEMS = 100;
const MAX_CANVAS_ITEM_BYTES = 256 * 1024;
const MAX_CANVAS_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_CANVAS_IMAGE_CHARS = 64 * 1024 * 1024;

/** Mirrors `WsImageAttachment` in `./types.ts`, with bounded ingress. */
export const attachmentSchema = z.object({
  kind: z.literal("image"),
  filename: z.string().max(512).optional(),
  mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  data: z.string().max(32 * 1024 * 1024),
});

const canvasContextItemSchema = z.object({
  nodeId: z.string().min(1).max(512),
  nodeType: z.string().min(1).max(128),
  label: z.string().max(512),
  content: z.string().max(MAX_CANVAS_ITEM_BYTES),
  attachments: z.array(attachmentSchema).max(20).optional(),
});

export const canvasContextItemsSchema = z.array(canvasContextItemSchema).max(MAX_CANVAS_ITEMS)
  .superRefine((items, ctx) => {
    const textBytes = items.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
    if (textBytes > MAX_CANVAS_SNAPSHOT_BYTES) ctx.addIssue({
      code: "custom", message: "connected canvas text exceeds the 2 MiB snapshot limit",
    });
    const imageChars = items.flatMap((item) => item.attachments ?? [])
      .reduce((sum, attachment) => sum + attachment.data.length, 0);
    if (imageChars > MAX_CANVAS_IMAGE_CHARS) ctx.addIssue({
      code: "custom", message: "connected canvas images exceed the 64 MiB encoded limit",
    });
  });
