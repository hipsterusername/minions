/**
 * Lock in the WebSocket payload ceiling so it can't silently regress to
 * the old 1MB limit, which rejected ordinary image attachments with a
 * 1009 close code.
 */
import { describe, expect, it } from "vitest";
import { WS_MAX_PAYLOAD_BYTES } from "./ws-config.ts";

describe("WS_MAX_PAYLOAD_BYTES", () => {
  it("leaves room for a base64-encoded screenshot plus JSON envelope", () => {
    // A 10MB raw image becomes ~13.4MB once base64-encoded. Anything less
    // than that would start rejecting reasonable screenshots.
    const tenMbBase64 = Math.ceil((10 * 1024 * 1024 * 4) / 3);
    expect(WS_MAX_PAYLOAD_BYTES).toBeGreaterThan(tenMbBase64);
  });

  it("stays well below the ws library default (100MiB)", () => {
    expect(WS_MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
