/**
 * Path-based image loader.
 *
 * Bridges a project-relative file path (e.g. "assets/screenshot.png") to
 * the same {@link LoadedImage} shape that the File-based pipeline yields.
 * The server's /blob endpoint streams the raw bytes; this helper wraps
 * the response in a {@link File} so it can run through the existing
 * {@link loadImageFromFile} pipeline (decode → downscale → re-encode).
 *
 * Lives in its own file so unit tests can mock fetch without dragging
 * the whole image-loader DOM-canvas pipeline into module init.
 */
import { encodePath, getAuthToken } from "../api.ts";
import { loadImageFromFile, type LoadedImage } from "./image-loader.ts";

/**
 * Set of file extensions (lower-case, no dot) the canvas treats as
 * images. Used by the open-file dispatcher to decide between ImageNode
 * and FileViewerNode. Keep in sync with {@link IMAGE_BLOB_MIME_TYPES} on
 * the server side.
 */
export const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);

/** True when `relativePath` ends in a known image extension. */
export function isImagePath(relativePath: string): boolean {
  const i = relativePath.lastIndexOf(".");
  if (i < 0) return false;
  return IMAGE_FILE_EXTENSIONS.has(relativePath.slice(i + 1).toLowerCase());
}

/** Pull the basename off a forward-slash relative path. */
function basename(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i < 0 ? relativePath : relativePath.slice(i + 1);
}

/**
 * Fetch a project file from the /blob endpoint and run it through the
 * shared image-loader pipeline. Returns a {@link LoadedImage} ready to
 * feed an {@link ImageNode}.
 *
 * Throws when the fetch fails or the response is not an image — callers
 * can surface the error or fall back to the file-viewer path.
 */
export async function loadImageFromProjectPath(
  projectPath: string,
  relativePath: string,
): Promise<LoadedImage> {
  const encoded = encodePath(projectPath);
  const url = `/api/projects/${encoded}/blob?path=${encodeURIComponent(relativePath)}`;
  const token = await getAuthToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to load image (${res.status}): ${relativePath}`);
  }
  const blob = await res.blob();
  const mime = blob.type || "image/png";
  const file = new File([blob], basename(relativePath), { type: mime });
  return loadImageFromFile(file);
}
