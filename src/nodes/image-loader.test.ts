/**
 * planImageDownscale — the pure planning half of the image loader.
 * Covers the decision matrix: skip small-and-light, cap long edge,
 * preserve aspect ratio on landscape and portrait, trigger on byte size
 * even when dimensions are modest.
 *
 * The runtime canvas pipeline (`loadImageFromFile`) is not unit-tested
 * here — jsdom doesn't rasterize — and is covered at integration time.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_EDGE_PX,
  planImageDownscale,
} from "./image-loader.ts";

describe("planImageDownscale", () => {
  it("returns null for images already within both budgets", () => {
    expect(
      planImageDownscale({
        width: 800,
        height: 600,
        byteSize: 200 * 1024,
        mediaType: "image/png",
      }),
    ).toBeNull();
  });

  it("caps landscape long edge at MAX_IMAGE_EDGE_PX and preserves aspect", () => {
    const plan = planImageDownscale({
      width: 4000,
      height: 3000,
      byteSize: 8 * 1024 * 1024,
      mediaType: "image/jpeg",
    });
    expect(plan).not.toBeNull();
    expect(plan!.targetWidth).toBe(MAX_IMAGE_EDGE_PX);
    // 3000 * (1568/4000) = 1176
    expect(plan!.targetHeight).toBe(1176);
    expect(plan!.outputMediaType).toBe("image/jpeg");
  });

  it("caps portrait long edge at MAX_IMAGE_EDGE_PX and preserves aspect", () => {
    const plan = planImageDownscale({
      width: 1500,
      height: 5000,
      byteSize: 6 * 1024 * 1024,
      mediaType: "image/png",
    });
    expect(plan).not.toBeNull();
    expect(plan!.targetHeight).toBe(MAX_IMAGE_EDGE_PX);
    // 1500 * (1568/5000) = 470.4 -> 470
    expect(plan!.targetWidth).toBe(470);
  });

  it("triggers on byte size even when dimensions are modest", () => {
    // A 900x900 PNG at ~10MB (dense illustrations, screenshots with lots
    // of gradients) is under the edge cap but still needs recompression.
    const plan = planImageDownscale({
      width: 900,
      height: 900,
      byteSize: 10 * 1024 * 1024,
      mediaType: "image/png",
    });
    expect(plan).not.toBeNull();
    expect(plan!.targetWidth).toBe(900);
    expect(plan!.targetHeight).toBe(900);
    expect(plan!.outputMediaType).toBe("image/jpeg");
  });

  it("never produces a zero dimension on pathological aspect ratios", () => {
    const plan = planImageDownscale({
      width: 1,
      height: 10000,
      byteSize: 2 * 1024 * 1024,
      mediaType: "image/png",
    });
    expect(plan).not.toBeNull();
    expect(plan!.targetWidth).toBeGreaterThanOrEqual(1);
    expect(plan!.targetHeight).toBe(MAX_IMAGE_EDGE_PX);
  });

  it("returns null for non-positive dimensions (undecoded source)", () => {
    expect(
      planImageDownscale({
        width: 0,
        height: 0,
        byteSize: 50 * 1024 * 1024,
        mediaType: "image/jpeg",
      }),
    ).toBeNull();
  });
});
