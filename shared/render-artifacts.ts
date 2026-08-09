/**
 * Artifact component schemas — image and file-preview.
 *
 * Companion to shared/render-dsl.ts. Kept separate because these components
 * reference file-system paths and binary content, which have different
 * rendering constraints from the core dashboard primitives.
 */

import { z } from "zod/v4";
import { spanSchema } from "./render-base.ts";

/**
 * Model-produced dashboards must not be able to make the browser contact an
 * arbitrary host. Only embedded, non-SVG raster images are accepted. SVG is
 * deliberately excluded because it can contain active or external content.
 */
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=_-]*$/i;

export function isSafeModelGeneratedImageSrc(src: string): boolean {
  return SAFE_IMAGE_DATA_URL.test(src);
}

export function toSafeEmbeddedRasterDataUrl(
  mime: string | undefined,
  base64: string,
): string | null {
  const candidate = `data:${mime ?? "image/png"};base64,${base64}`;
  return isSafeModelGeneratedImageSrc(candidate) ? candidate : null;
}

// ── Image ──────────────────────────────────────────────────

export const imageComponentSchema = z.object({
  id: z.string(),
  type: z.literal("image"),
  /** Embedded raster data only; external and active URLs are rejected. */
  src: z.string().refine(isSafeModelGeneratedImageSrc, {
    message: "image src must be an embedded PNG, JPEG, GIF, or WebP data URL",
  }),
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

// ── HTML artifact ──────────────────────────────────────────

/**
 * A non-functional, visualization-only HTML artifact.
 *
 * The `html` field is ALWAYS sanitized on the server (see
 * `server/html-sanitize.ts`) before it is broadcast — no unsanitized HTML
 * ever reaches a client. On the client it is rendered inside an
 * empty-`sandbox` iframe (no scripts, no same-origin, no forms, no
 * top-navigation) as defense-in-depth. It is intended for static
 * visualizations only: scripts, forms, event handlers, external resource
 * loads, and navigation are all stripped and/or blocked.
 */
export const htmlArtifactComponentSchema = z.object({
  id: z.string(),
  type: z.literal("html-artifact"),
  /**
   * Sanitized, visualization-only HTML. The server rewrites this field
   * through the sanitizer before broadcast; the client renders it via
   * `<iframe sandbox srcdoc={html}>`.
   */
  html: z.string(),
  /** Optional heading shown above the preview. */
  title: z.string().optional(),
  /** Preview height in px. Defaults to 240 on the client. */
  height: z.number().optional(),
  /**
   * Opaque id of the persisted temp artifact file (session-scoped). Present
   * when the artifact was created via `publish_html`; used for bookkeeping
   * and lifecycle cleanup, not for rendering.
   */
  artifactId: z.string().optional(),
  span: spanSchema.optional(),
});

export type HtmlArtifactComponent = z.infer<typeof htmlArtifactComponentSchema>;

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

/**
 * Serialize an html-artifact component as a compact markdown summary.
 * The raw HTML is intentionally NOT inlined — it is a visualization surface,
 * not text — so we emit a one-line descriptor instead.
 */
export function formatHtmlArtifact(c: HtmlArtifactComponent): string {
  const name = c.title ?? "HTML artifact";
  const size = c.html.length;
  return `HTML artifact: ${name} (${size} bytes, visualization only)`;
}
