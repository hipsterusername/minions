/**
 * Real-fs tests for Codex attachment scratch management.
 *
 * No mocks — these tests write to os.tmpdir() and clean up via dispose().
 * Each test uses a unique sessionKey (derived from Date.now() + counter) to
 * avoid cross-test collisions even when vitest runs tests in parallel.
 */

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { buildCodexInput, writeCodexAttachments } from "./attachments.ts";
import type { CodexAttachmentScratch } from "./attachments.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Minimal 1×1 PNG, base64-encoded. Used as a stand-in for real image bytes;
 * the harness only cares about round-tripping the raw bytes.
 */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ── Helpers ───────────────────────────────────────────────────────────────────

let counter = 0;

function uniqueKey(): string {
  return `test-att-${Date.now()}-${++counter}`;
}

// Collect all scratch handles so afterEach can dispose them even on failure.
const pendingDispose: CodexAttachmentScratch[] = [];

afterEach(async () => {
  for (const s of pendingDispose) {
    await s.dispose();
  }
  pendingDispose.length = 0;
});

/** Register a scratch for cleanup and return it unchanged. */
function track(s: CodexAttachmentScratch): CodexAttachmentScratch {
  pendingDispose.push(s);
  return s;
}

// ── writeCodexAttachments ─────────────────────────────────────────────────────

describe("writeCodexAttachments", () => {
  it("writes one file per attachment", async () => {
    const scratch = track(
      await writeCodexAttachments({
        sessionKey: uniqueKey(),
        attachments: [{ kind: "image", mediaType: "image/png", data: PNG_1X1 }],
      }),
    );

    const files = await fs.readdir(scratch.dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("attachment-0.png");
  });

  it("assigns correct extension per mediaType (jpeg→jpg, png→png, gif→gif, webp→webp)", async () => {
    const scratch = track(
      await writeCodexAttachments({
        sessionKey: uniqueKey(),
        attachments: [
          { kind: "image", mediaType: "image/jpeg", data: PNG_1X1 },
          { kind: "image", mediaType: "image/png", data: PNG_1X1 },
          { kind: "image", mediaType: "image/gif", data: PNG_1X1 },
          { kind: "image", mediaType: "image/webp", data: PNG_1X1 },
        ],
      }),
    );

    const files = (await fs.readdir(scratch.dir)).sort();
    expect(files).toEqual([
      "attachment-0.jpg",
      "attachment-1.png",
      "attachment-2.gif",
      "attachment-3.webp",
    ]);
  });

  it("decoded bytes round-trip correctly", async () => {
    const scratch = track(
      await writeCodexAttachments({
        sessionKey: uniqueKey(),
        attachments: [{ kind: "image", mediaType: "image/png", data: PNG_1X1 }],
      }),
    );

    const written = await fs.readFile(path.join(scratch.dir, "attachment-0.png"));
    expect(written).toEqual(Buffer.from(PNG_1X1, "base64"));
  });

  it("inputs length matches attachments count", async () => {
    const scratch = track(
      await writeCodexAttachments({
        sessionKey: uniqueKey(),
        attachments: [
          { kind: "image", mediaType: "image/png", data: PNG_1X1 },
          { kind: "image", mediaType: "image/jpeg", data: PNG_1X1 },
        ],
      }),
    );

    expect(scratch.inputs).toHaveLength(2);
  });

  it("each input is { type: 'local_image', path } pointing at the written file", async () => {
    const scratch = track(
      await writeCodexAttachments({
        sessionKey: uniqueKey(),
        attachments: [{ kind: "image", mediaType: "image/png", data: PNG_1X1 }],
      }),
    );

    expect(scratch.inputs).toEqual([
      { type: "local_image", path: path.join(scratch.dir, "attachment-0.png") },
    ]);
  });

  it("re-writing for the same sessionKey wipes prior contents", async () => {
    const key = uniqueKey();

    // First write — one attachment.
    await writeCodexAttachments({
      sessionKey: key,
      attachments: [{ kind: "image", mediaType: "image/png", data: PNG_1X1 }],
    });
    // Do not track — the second write disposes it.

    // Second write — two attachments; should replace the first.
    const scratch = track(
      await writeCodexAttachments({
        sessionKey: key,
        attachments: [
          { kind: "image", mediaType: "image/png", data: PNG_1X1 },
          { kind: "image", mediaType: "image/jpeg", data: PNG_1X1 },
        ],
      }),
    );

    const files = await fs.readdir(scratch.dir);
    expect(files).toHaveLength(2);
  });

  it("dispose removes the scratch directory", async () => {
    const scratch = await writeCodexAttachments({
      sessionKey: uniqueKey(),
      attachments: [{ kind: "image", mediaType: "image/png", data: PNG_1X1 }],
    });

    await scratch.dispose();
    await expect(fs.access(scratch.dir)).rejects.toThrow();
  });

  it("dispose is idempotent (second call does not throw)", async () => {
    const scratch = await writeCodexAttachments({
      sessionKey: uniqueKey(),
      attachments: [{ kind: "image", mediaType: "image/png", data: PNG_1X1 }],
    });

    await scratch.dispose();
    await expect(scratch.dispose()).resolves.toBeUndefined();
  });

  it("empty attachments array produces empty inputs", async () => {
    // The implementation always creates the directory even with zero attachments.
    // Tests should not rely on the dir's existence post-dispose, only on inputs.
    const scratch = track(
      await writeCodexAttachments({ sessionKey: uniqueKey(), attachments: [] }),
    );

    expect(scratch.inputs).toHaveLength(0);
  });

  it("throws a clear error for sessionKey containing /", async () => {
    await expect(
      writeCodexAttachments({ sessionKey: "foo/bar", attachments: [] }),
    ).rejects.toThrow(/invalid sessionKey/);
  });

  it("throws a clear error for sessionKey containing ..", async () => {
    await expect(
      writeCodexAttachments({ sessionKey: "../escape", attachments: [] }),
    ).rejects.toThrow(/invalid sessionKey/);
  });
});

// ── buildCodexInput ───────────────────────────────────────────────────────────

describe("buildCodexInput", () => {
  it("returns the plain prompt string when scratch is null", () => {
    expect(buildCodexInput("hello", null)).toBe("hello");
  });

  it("returns the plain prompt string when scratch has zero inputs", async () => {
    const scratch = track(
      await writeCodexAttachments({ sessionKey: uniqueKey(), attachments: [] }),
    );

    expect(buildCodexInput("hello", scratch)).toBe("hello");
  });

  it("returns [text, ...images] when scratch has inputs", async () => {
    const scratch = track(
      await writeCodexAttachments({
        sessionKey: uniqueKey(),
        attachments: [{ kind: "image", mediaType: "image/png", data: PNG_1X1 }],
      }),
    );

    expect(buildCodexInput("describe this", scratch)).toEqual([
      { type: "text", text: "describe this" },
      { type: "local_image", path: path.join(scratch.dir, "attachment-0.png") },
    ]);
  });

  it("prepends text entry even when prompt is empty string", async () => {
    const scratch = track(
      await writeCodexAttachments({
        sessionKey: uniqueKey(),
        attachments: [{ kind: "image", mediaType: "image/png", data: PNG_1X1 }],
      }),
    );

    const result = buildCodexInput("", scratch);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[])[0]).toEqual({ type: "text", text: "" });
  });
});
