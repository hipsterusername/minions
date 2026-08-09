/**
 * Rasterize ImageNode annotations into the image bytes themselves so the
 * leader's vision model SEES where the user pointed, not just reads
 * coordinates.
 *
 * Design split (mirrors src/nodes/image-loader.ts):
 *  - {@link drawAnnotationOverlay} is pure: given a 2D context surface
 *    and the annotation list, it stamps numbered pins / rects. Unit
 *    tested via a recording mock context — node env, no canvas needed.
 *  - {@link rasterizeAnnotatedImage} is the impure runtime wrapper that
 *    decodes the source image, blits it onto a canvas, calls the pure
 *    drawer, and returns a fresh `image/png` data URL. We don't unit
 *    test the canvas step — jsdom doesn't implement it; we trust the
 *    browser, exactly as image-loader does.
 *  - {@link lookupRasterizedAnnotatedImage} is the sync read path used
 *    by the (sync) attachment extractor. Falls back to `null` when no
 *    fresh render is cached for the given (src, annotations) pair, so
 *    the caller hands the unannotated source as a graceful fallback.
 *
 * Visual contract (kept deliberately minimal — see the leader prompt):
 *   - One color, magenta `#ff00ff`, rare in real UIs so unambiguous.
 *   - 2px stroke wrapped in a 4px white halo so the marks survive on
 *     any background.
 *   - Outline-only — no fills covering pixels the user wants the model
 *     to look at.
 *   - The annotation's `order` number is rendered in a small badge
 *     offset from the mark; that number is the cross-reference key
 *     back into the textual annotation list in the prompt.
 *
 * The full color palette and per-mark notes intentionally do NOT travel
 * with the image — they ride the existing text channel. Color in the
 * pixels would compete with the user's UI screenshot; notes would burn
 * image tokens that text tokens cover for free.
 */
import type { Annotation } from "../components/AnnotationLayer.tsx";

const MARK_COLOR = "#ff00ff";
const HALO_COLOR = "#ffffff";
const BADGE_BG = "#ff00ff";
const BADGE_TEXT = "#ffffff";

/**
 * Minimal subset of `CanvasRenderingContext2D` that the overlay drawer
 * actually uses. Declaring it here lets us mock-record calls in node
 * tests without dragging jsdom or the full DOM type surface into pure
 * logic.
 */
export interface OverlayContext {
  // Match `CanvasRenderingContext2D` exactly so a real browser context
  // is structurally assignable. We only ever assign string colors at
  // call sites, but the wider type lets the impure rasterizer pass its
  // canvas context in without a cast.
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  beginPath(): void;
  arc(x: number, y: number, r: number, startAngle: number, endAngle: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

interface MarkSizes {
  pinR: number;
  stroke: number;
  halo: number;
  fontPx: number;
}

function computeMarkSizes(imageWidth: number, imageHeight: number): MarkSizes {
  const minDim = Math.max(1, Math.min(imageWidth, imageHeight));
  // Tuned so a 1568px screenshot gets ~20px font, ~8px pins, and a 2px
  // mark stroke; a tiny 200px thumbnail still gets a 12px font and a
  // visible mark.
  return {
    pinR: Math.max(6, Math.round(minDim / 200)),
    stroke: Math.max(2, Math.round(minDim / 600)),
    halo: Math.max(4, Math.round(minDim / 300)),
    fontPx: Math.max(12, Math.round(minDim / 80)),
  };
}

interface BadgeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  textX: number;
  textY: number;
}

function badgeBoxFor(
  ctx: OverlayContext,
  text: string,
  fontPx: number,
  anchorX: number,
  anchorY: number,
): BadgeBox {
  const padX = Math.max(3, Math.round(fontPx * 0.35));
  const padY = Math.max(2, Math.round(fontPx * 0.18));
  const tw = ctx.measureText(text).width;
  const w = Math.round(tw + padX * 2);
  const h = Math.round(fontPx + padY * 2);
  return {
    x: anchorX,
    y: anchorY,
    w,
    h,
    textX: anchorX + padX,
    textY: anchorY + padY,
  };
}

function drawBadge(ctx: OverlayContext, box: BadgeBox, halo: number, text: string): void {
  // Halo first so the magenta fill sits cleanly on top.
  ctx.lineWidth = halo;
  ctx.strokeStyle = HALO_COLOR;
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.stroke();
  ctx.fillStyle = BADGE_BG;
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.fill();
  ctx.fillStyle = BADGE_TEXT;
  ctx.fillText(text, box.textX, box.textY);
}

function drawPin(
  ctx: OverlayContext,
  cx: number,
  cy: number,
  order: number,
  sizes: MarkSizes,
): void {
  const { pinR, stroke, halo, fontPx } = sizes;
  // Halo arc beneath the magenta arc — survives any background.
  ctx.lineWidth = halo;
  ctx.strokeStyle = HALO_COLOR;
  ctx.beginPath();
  ctx.arc(cx, cy, pinR, 0, Math.PI * 2);
  ctx.stroke();
  // Magenta mark — outline only so the pixel under the pin stays visible.
  ctx.lineWidth = stroke;
  ctx.strokeStyle = MARK_COLOR;
  ctx.beginPath();
  ctx.arc(cx, cy, pinR, 0, Math.PI * 2);
  ctx.stroke();
  // Number badge offset upper-right so it does not occlude the target.
  const text = String(order);
  const box = badgeBoxFor(ctx, text, fontPx, cx + pinR + 4, cy - (fontPx + 6));
  drawBadge(ctx, box, halo, text);
}

function drawRect(
  ctx: OverlayContext,
  x: number,
  y: number,
  w: number,
  h: number,
  order: number,
  sizes: MarkSizes,
): void {
  const { stroke, halo, fontPx } = sizes;
  ctx.lineWidth = halo;
  ctx.strokeStyle = HALO_COLOR;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.stroke();
  ctx.lineWidth = stroke;
  ctx.strokeStyle = MARK_COLOR;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.stroke();
  // Badge anchored top-left, sitting outside the rect so the rect's
  // contents stay clean.
  const text = String(order);
  const box = badgeBoxFor(ctx, text, fontPx, x, y - (fontPx + 6));
  drawBadge(ctx, box, halo, text);
}

/**
 * Stamp the given annotations onto `ctx` at pixel positions derived
 * from each annotation's normalized coords scaled by image dimensions.
 *
 * Caller is responsible for having drawn the source image onto `ctx`
 * already; this function only adds the overlay.
 *
 * Pure: uses no DOM globals beyond the context surface, so it runs in
 * node environments with a recording mock.
 */
export function drawAnnotationOverlay(
  ctx: OverlayContext,
  annotations: ReadonlyArray<Annotation>,
  imageWidth: number,
  imageHeight: number,
): void {
  if (annotations.length === 0) return;
  const sizes = computeMarkSizes(imageWidth, imageHeight);
  ctx.font = `bold ${sizes.fontPx}px sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  // Render in numbered order so any visual overlap looks consistent
  // with the textual list the model reads alongside the image.
  const sorted = [...annotations].sort((a, b) => a.order - b.order);
  for (const a of sorted) {
    if (a.kind === "pin") {
      drawPin(ctx, a.x * imageWidth, a.y * imageHeight, a.order, sizes);
    } else {
      drawRect(
        ctx,
        a.x * imageWidth,
        a.y * imageHeight,
        a.w * imageWidth,
        a.h * imageHeight,
        a.order,
        sizes,
      );
    }
  }
}

// ── Cache + lookup ────────────────────────────────────────

interface CacheEntry {
  fingerprint: string;
  output: string;
}

/**
 * Module-level cache keyed by the source `data:` URL. Holds at most one
 * rasterized output per source; when the annotation set for a given
 * source changes we overwrite the entry rather than accumulate stale
 * renders. Memory therefore grows linearly with the number of distinct
 * source images, not the number of annotation edits.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Stable fingerprint of the geometry that affects the overlay. Notes
 * and per-annotation colors are excluded — we render uniform magenta,
 * and the model reads notes from the text channel, so changes to those
 * do not require a re-render.
 */
export function fingerprintAnnotations(
  annotations: ReadonlyArray<Annotation>,
): string {
  if (annotations.length === 0) return "0";
  const parts = [...annotations]
    .sort((a, b) => a.order - b.order)
    .map((a) =>
      a.kind === "pin"
        ? `p:${a.order}:${a.x.toFixed(4)},${a.y.toFixed(4)}`
        : `r:${a.order}:${a.x.toFixed(4)},${a.y.toFixed(4)},${a.w.toFixed(4)},${a.h.toFixed(4)}`,
    );
  return `${parts.length}|${parts.join("|")}`;
}

/**
 * Sync read used by the attachment extractor. Returns the cached
 * rasterized data URL if its fingerprint matches the requested
 * annotation set, otherwise null.
 */
export function lookupRasterizedAnnotatedImage(
  src: string,
  annotations: ReadonlyArray<Annotation>,
): string | null {
  if (annotations.length === 0) return null;
  const entry = cache.get(src);
  if (!entry) return null;
  return entry.fingerprint === fingerprintAnnotations(annotations) ? entry.output : null;
}

/** Test-only: drop every cached entry. Not exported to production code paths. */
export function _resetRasterCacheForTests(): void {
  cache.clear();
}

/**
 * Test-only: seed the cache with a synthetic rasterized output, so the
 * (sync) attachment-extractor path can be exercised in jsdom without
 * actually running the canvas pipeline.
 */
export function _seedRasterCacheForTests(
  src: string,
  annotations: ReadonlyArray<Annotation>,
  output: string,
): void {
  if (annotations.length === 0) return;
  cache.set(src, { fingerprint: fingerprintAnnotations(annotations), output });
}

// ── Browser-side rasterizer ───────────────────────────────

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = src;
  });
}

/**
 * Decode `src`, blit it onto a canvas at the natural dimensions, stamp
 * the annotation overlay, and return a fresh `image/png` data URL.
 *
 * Empty annotations short-circuit to the original src — both for speed
 * and so the cache stays clean for "no overlay" cases.
 *
 * Errors (decode failure, no 2D context) propagate to the caller; the
 * caller is responsible for falling back to the unannotated source.
 */
export async function rasterizeAnnotatedImage(
  src: string,
  annotations: ReadonlyArray<Annotation>,
  naturalWidth: number,
  naturalHeight: number,
): Promise<string> {
  if (annotations.length === 0) return src;
  const fp = fingerprintAnnotations(annotations);
  const existing = cache.get(src);
  if (existing && existing.fingerprint === fp) return existing.output;

  const img = await decodeImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, naturalWidth, naturalHeight);
  drawAnnotationOverlay(ctx, annotations, naturalWidth, naturalHeight);
  // PNG keeps the overlay's sharp edges and small numbers crisp; JPEG
  // dithers the magenta strokes against the underlying screenshot,
  // which is the very signal we want preserved.
  const output = canvas.toDataURL("image/png");
  cache.set(src, { fingerprint: fp, output });
  return output;
}
