/**
 * Shared image loader for the canvas.
 *
 * Turns a user-supplied File (dragged, dropped, pasted, or picked) into a
 * node-ready `{ src, naturalWidth, naturalHeight, filename, mediaType }`
 * tuple. The key responsibility beyond a plain `FileReader` is
 * **downscaling**: raw camera photos and 4K/5K screenshots often
 * exceed the WebSocket payload ceiling when sent to the Leader as a
 * base64 `data:` URL, and vision models already cap useful resolution
 * around 1568px on the long edge — anything larger costs tokens without
 * buying accuracy.
 *
 * Design split:
 *  - `planImageDownscale` is pure and unit-tested. Given source dimensions,
 *    byte size, and mime type, it returns the target dimensions and
 *    output encoding, or `null` if the source is already fine.
 *  - `loadImageFromFile` is the impure runtime pipeline that reads the
 *    file, applies the plan via a canvas, and yields the final data URL.
 *    We don't unit-test the canvas step — jsdom doesn't implement it — we
 *    trust the browser.
 */

/**
 * Claude's vision models resample images larger than ~1568px on the long
 * edge, so anything beyond that is wasted bandwidth and tokens.
 */
export const MAX_IMAGE_EDGE_PX = 1568;

/**
 * Stay well below the server's 32MB WebSocket cap once the envelope
 * (prompt text, annotation geometry, JSON overhead, base64 inflation)
 * is accounted for. Anything over 4MB raw triggers a downscale+recompress
 * pass, even if the dimensions are modest.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** JPEG quality used when we re-encode. 0.85 is the usual sweet spot. */
export const DOWNSCALE_JPEG_QUALITY = 0.85;

export type DownscalePlan = {
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly outputMediaType: "image/jpeg";
  readonly quality: number;
};

export type ImageSourceProfile = {
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly mediaType: string;
};

/**
 * Decide whether an image needs to be resized and/or recompressed before
 * it can safely ride the WS channel.
 *
 * Returns `null` when the source is already within both the dimensional
 * and byte-size budgets. Otherwise returns target dimensions (aspect
 * preserved, long edge capped at {@link MAX_IMAGE_EDGE_PX}) and the
 * output encoding.
 *
 * We always re-encode as JPEG when we do any work at all. PNGs don't
 * shrink meaningfully on downscale alone, and JPEG at q=0.85 typically
 * yields a 5–10× size reduction on screenshots/photos without visible
 * quality loss at vision-model resolutions. Transparency is sacrificed
 * knowingly — the overwhelming majority of inputs are opaque
 * screenshots and camera photos.
 */
export function planImageDownscale(profile: ImageSourceProfile): DownscalePlan | null {
  const { width, height, byteSize } = profile;
  if (width <= 0 || height <= 0) return null;

  const longEdge = Math.max(width, height);
  const overDim = longEdge > MAX_IMAGE_EDGE_PX;
  const overSize = byteSize > MAX_IMAGE_BYTES;
  if (!overDim && !overSize) return null;

  const scale = overDim ? MAX_IMAGE_EDGE_PX / longEdge : 1;
  // Preserve aspect ratio; round to whole pixels. Clamp to at least 1
  // so a pathological 1×N input doesn't collapse to a zero dimension.
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  return {
    targetWidth,
    targetHeight,
    outputMediaType: "image/jpeg",
    quality: DOWNSCALE_JPEG_QUALITY,
  };
}

export type LoadedImage = {
  readonly src: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly filename: string;
  readonly mediaType: string;
};

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = src;
  });
}

function rasterize(img: HTMLImageElement, plan: DownscalePlan): string {
  const canvas = document.createElement("canvas");
  canvas.width = plan.targetWidth;
  canvas.height = plan.targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // No 2D context (extremely unusual in a browser) — fall back to the
    // original. Better to risk a WS rejection than to silently lose the
    // user's image.
    throw new Error("Canvas 2D context unavailable");
  }
  ctx.drawImage(img, 0, 0, plan.targetWidth, plan.targetHeight);
  return canvas.toDataURL(plan.outputMediaType, plan.quality);
}

/**
 * Read `file`, decode it, and return a node-ready payload. Downscales
 * and recompresses in-place when the source would otherwise blow the
 * WS ceiling.
 *
 * Falls back to the raw data URL if anything in the downscale path
 * throws — the user's image is more important than the optimisation.
 */
export async function loadImageFromFile(file: File): Promise<LoadedImage> {
  const rawSrc = await readFileAsDataURL(file);
  const img = await decodeImage(rawSrc);
  const naturalWidth = img.naturalWidth;
  const naturalHeight = img.naturalHeight;
  const filename = file.name && file.name !== "" ? file.name : "Pasted image";

  const plan = planImageDownscale({
    width: naturalWidth,
    height: naturalHeight,
    byteSize: file.size,
    mediaType: file.type,
  });
  if (!plan) {
    return {
      src: rawSrc,
      naturalWidth,
      naturalHeight,
      filename,
      mediaType: file.type || "image/png",
    };
  }

  try {
    const scaled = rasterize(img, plan);
    return {
      src: scaled,
      naturalWidth: plan.targetWidth,
      naturalHeight: plan.targetHeight,
      filename,
      mediaType: plan.outputMediaType,
    };
  } catch (err) {
    console.warn(
      "[image-loader] downscale failed, falling back to original:",
      err instanceof Error ? err.message : err,
    );
    return {
      src: rawSrc,
      naturalWidth,
      naturalHeight,
      filename,
      mediaType: file.type || "image/png",
    };
  }
}
