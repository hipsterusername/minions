/**
 * sanitizeAttachments — WS boundary validation. Guards the server
 * against malformed image payloads before they reach the SDK.
 */
import { describe, expect, it } from "vitest";
import { sanitizeAttachments } from "./attachment-sanitize.ts";

describe("sanitizeAttachments", () => {
  // Note: a "returns undefined for non-arrays" check was removed per
  // testing-strategy.md §5.1 — it asserted `Array.isArray` semantics, not
  // anything about sanitisation.

  it("returns undefined for empty arrays", () => {
    expect(sanitizeAttachments([])).toBeUndefined();
  });

  it("returns undefined when every item is malformed", () => {
    expect(
      sanitizeAttachments([
        null,
        {},
        { kind: "image" },
        { kind: "image", mediaType: "image/png" }, // missing data
        { kind: "image", data: "Z", mediaType: "image/bmp" }, // unsupported type
        { kind: "image", data: "", mediaType: "image/png" }, // empty data
        { kind: "video", mediaType: "image/png", data: "Z" }, // wrong kind
      ]),
    ).toBeUndefined();
  });

  it("keeps valid attachments and strips malformed ones in a mixed input", () => {
    const out = sanitizeAttachments([
      { kind: "image", mediaType: "image/png", data: "OK1", filename: "a.png" },
      { kind: "image", mediaType: "image/heic", data: "BAD" }, // unsupported
      { kind: "image", mediaType: "image/jpeg", data: "OK2" },
    ]);
    expect(out).toHaveLength(2);
    expect(out![0]).toEqual({
      kind: "image",
      mediaType: "image/png",
      data: "OK1",
      filename: "a.png",
    });
    expect(out![1]).toEqual({ kind: "image", mediaType: "image/jpeg", data: "OK2" });
  });

  it("omits filename when empty string, preserving non-empty", () => {
    const out = sanitizeAttachments([
      { kind: "image", mediaType: "image/png", data: "A", filename: "" },
      { kind: "image", mediaType: "image/png", data: "B", filename: "b.png" },
    ]);
    expect(out![0]!.filename).toBeUndefined();
    expect(out![1]!.filename).toBe("b.png");
  });
});
