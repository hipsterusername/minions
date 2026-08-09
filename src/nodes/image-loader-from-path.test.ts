/**
 * Tests for the path-based image loader.
 *
 * The pure helpers (extension detection) are unit-tested directly. The
 * fetch wiring is verified by stubbing `fetch` and asserting that the
 * helper hits the encoded /blob URL with an Authorization header and
 * surfaces non-2xx responses as a thrown error. The DOM-canvas leg of
 * the pipeline (`loadImageFromFile`) is exercised at integration time —
 * jsdom doesn't decode images.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAuthToken } from "../api.ts";
import {
  IMAGE_FILE_EXTENSIONS,
  isImagePath,
  loadImageFromProjectPath,
} from "./image-loader-from-path.ts";

describe("isImagePath", () => {
  it("returns true for every extension we treat as an image", () => {
    for (const ext of IMAGE_FILE_EXTENSIONS) {
      expect(isImagePath(`assets/photo.${ext}`)).toBe(true);
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(isImagePath("Screenshot.PNG")).toBe(true);
    expect(isImagePath("Photo.JPG")).toBe(true);
  });

  it("returns false for non-image extensions", () => {
    expect(isImagePath("README.md")).toBe(false);
    expect(isImagePath("src/index.ts")).toBe(false);
    expect(isImagePath("data.json")).toBe(false);
  });

  it("returns false when there is no extension", () => {
    expect(isImagePath("Makefile")).toBe(false);
    expect(isImagePath("")).toBe(false);
  });

  it("does not confuse a dot in a directory name with an extension", () => {
    // The dot is in the dir segment, the file itself has no extension.
    expect(isImagePath("v1.0/manifest")).toBe(false);
  });
});

describe("loadImageFromProjectPath — fetch wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearAuthToken();
  });

  it("requests the encoded /blob URL with an Authorization header", async () => {
    // Two fetches happen: /api/auth/token (from getAuthToken on first
    // use) then /api/projects/<encoded>/blob. We resolve the auth call
    // with a fixed token, then resolve the blob call with a 500 so the
    // pipeline short-circuits before the DOM-canvas decode (jsdom can't
    // rasterize an Image element).
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/auth/token")) {
          return new Response(JSON.stringify({ token: "test-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("nope", { status: 500 });
      });

    await expect(
      loadImageFromProjectPath(
        "/home/user/proj",
        "assets/screenshot.png",
      ),
    ).rejects.toThrow(/Failed to load image/);

    const blobCall = fetchSpy.mock.calls.find(([u]) =>
      String(u).includes("/blob"),
    );
    expect(blobCall).toBeDefined();
    const [url, init] = blobCall as [string, RequestInit];
    expect(url).toMatch(
      /^\/api\/projects\/[A-Za-z0-9_-]+\/blob\?path=assets%2Fscreenshot\.png$/,
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });
});
