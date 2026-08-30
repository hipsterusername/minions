/**
 * Tests for createImageNodeFromProjectPath — the factory invoked by the
 * project-tree open-file handler when the clicked file is an image.
 *
 * We mock fetch (a true boundary) and verify the failure-path contract:
 * if the blob fetch fails the factory returns false WITHOUT dispatching
 * a node, so the caller can fall back to FileViewer rather than leaving
 * an empty image slot on the canvas.
 *
 * The success path drives the DOM-canvas image pipeline which jsdom
 * does not implement — see image-loader.test.ts §header for the
 * project-wide convention to leave that path to integration.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanvasAction, CanvasTransform } from "../types.ts";
import { clearAuthToken } from "../api.ts";
import { createImageNodeFromProjectPath } from "./image-node-factory.ts";

const IDENTITY_TRANSFORM: CanvasTransform = { x: 0, y: 0, scale: 1 };

afterEach(() => {
  vi.restoreAllMocks();
  clearAuthToken();
});

describe("createImageNodeFromProjectPath", () => {
  it("returns false and skips dispatch when the blob fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/auth/token")) {
        return new Response(JSON.stringify({ token: "t" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    });

    const dispatch = vi.fn<(a: CanvasAction) => void>();
    const setSelectedIds = vi.fn<(ids: Set<string>) => void>();

    const ok = await createImageNodeFromProjectPath(
      "/workspace/proj",
      "assets/missing.png",
      dispatch,
      setSelectedIds,
      IDENTITY_TRANSFORM,
      [],
    );

    expect(ok).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(setSelectedIds).not.toHaveBeenCalled();
  });
});
