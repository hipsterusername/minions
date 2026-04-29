/**
 * Artifact component schemas — image and file-preview.
 *
 * Companion to shared/render-dsl.ts. Kept separate because these components
 * reference file-system paths and binary content, which have different
 * rendering constraints from the core dashboard primitives.
 */

import { z } from "zod/v4";
import { spanSchema } from "./render-base.ts";

// ── Image ──────────────────────────────────────────────────

export const imageComponentSchema = z.object({
  id: z.string(),
  type: z.literal("image"),
  /** file://, https://, or data: URI. Passed through as-is. */
  src: z.string(),
  alt: z.string(),
  caption: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  /** How the image fits its container. Defaults to "contain". */
  fit: z.enum(["contain", "cover", "actual"]).optional(),
  span: spanSchema.optional(),
});

export type ImageComponent = z.infer<typeof imageComponentSchema>;

// ── File preview ───────────────────────────────────────────

export const filePreviewSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: z.string() }),
  z.object({
    kind: z.literal("inline"),
    content: z.string(),
    mime: z.string().optional(),
  }),
]);

export const filePreviewComponentSchema = z.object({
  id: z.string(),
  type: z.literal("file-preview"),
  source: filePreviewSourceSchema,
  /** "auto" (default) detects view mode from mime type or filename extension. */
  view: z.enum(["auto", "text", "json", "csv", "image", "hex"]).optional(),
  /** Truncation cap in bytes. Omit for no limit. */
  maxBytes: z.number().optional(),
  actions: z.array(z.enum(["open", "download", "copy-path"])).optional(),
  filename: z.string().optional(),
  span: spanSchema.optional(),
});

export type FilePreviewComponent = z.infer<typeof filePreviewComponentSchema>;
export type FilePreviewSource = z.infer<typeof filePreviewSourceSchema>;

// ── Markdown helpers ───────────────────────────────────────

/**
 * Serialize an image component as a markdown image string.
 * Caption (if any) is appended as italic text on the next line.
 */
export function formatImage(c: ImageComponent): string {
  const img = `![${c.alt}](${c.src})`;
  return c.caption !== undefined ? `${img}\n*${c.caption}*` : img;
}

/**
 * Serialize a file-preview component as a compact markdown summary.
 * Path sources become a link; inline sources become a metadata line.
 */
export function formatFilePreview(c: FilePreviewComponent): string {
  if (c.source.kind === "path") {
    const name = c.filename ?? c.source.path;
    return `[File: ${name}](${c.source.path})`;
  }
  // inline
  const name = c.filename ?? "inline content";
  const size = c.source.content.length;
  const type = c.source.mime ?? "unknown type";
  return `File preview: ${name} (${size} bytes, ${type})`;
}
