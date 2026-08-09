import { describe, expect, it } from "vitest";

import {
  appendTextAttachmentsToPrompt,
  fileToImageAttachment,
  fileToTextAttachment,
  isAcceptedImageType,
  isAcceptedTextFile,
  type ImageAttachmentReaderFactory,
  type TextAttachmentReaderFactory,
} from "./attachments.ts";

describe("mobile attachments", () => {
  it("converts a PNG File to a raw-base64 image attachment", async () => {
    const readerFactory: ImageAttachmentReaderFactory = () => {
      const reader: ReturnType<ImageAttachmentReaderFactory> = {
        result: null,
        error: null,
        onload: null,
        onerror: null,
        readAsDataURL: () => {
          reader.result = "data:image/png;base64,UE5HREFUQQ==";
          reader.onload?.call(
            undefined as unknown as FileReader,
            { type: "load" } as ProgressEvent<FileReader>,
          );
        },
      };
      return reader;
    };
    const file = new File(["png"], "shot.png", { type: "image/png" });

    await expect(fileToImageAttachment(file, readerFactory)).resolves.toEqual({
      kind: "image",
      mediaType: "image/png",
      data: "UE5HREFUQQ==",
      filename: "shot.png",
    });
  });

  it("throws on unsupported image types", async () => {
    const file = new File(["tiff"], "scan.tiff", { type: "image/tiff" });

    await expect(fileToImageAttachment(file)).rejects.toThrow("Unsupported image type");
  });

  it("identifies accepted media types", () => {
    expect(isAcceptedImageType("image/jpeg")).toBe(true);
    expect(isAcceptedImageType("image/png")).toBe(true);
    expect(isAcceptedImageType("image/gif")).toBe(true);
    expect(isAcceptedImageType("image/webp")).toBe(true);
    expect(isAcceptedImageType("image/tiff")).toBe(false);
    expect(isAcceptedImageType("text/plain")).toBe(false);
  });

  it("converts Markdown files to text attachments", async () => {
    const readerFactory: TextAttachmentReaderFactory = () => {
      const reader: ReturnType<TextAttachmentReaderFactory> = {
        result: null,
        error: null,
        onload: null,
        onerror: null,
        readAsText: () => {
          reader.result = "# Notes";
          reader.onload?.call(
            undefined as unknown as FileReader,
            { type: "load" } as ProgressEvent<FileReader>,
          );
        },
      };
      return reader;
    };
    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });

    await expect(fileToTextAttachment(file, readerFactory)).resolves.toEqual({
      kind: "text",
      filename: "notes.md",
      mediaType: "text/markdown",
      text: "# Notes",
      truncated: false,
    });
  });

  it("identifies text-like files by media type or extension", () => {
    expect(isAcceptedTextFile(new File([""], "index.html", { type: "text/html" }))).toBe(true);
    expect(isAcceptedTextFile(new File([""], "README.md", { type: "" }))).toBe(true);
    expect(isAcceptedTextFile(new File([""], "data.json", { type: "application/json" }))).toBe(true);
    expect(isAcceptedTextFile(new File([""], "archive.zip", { type: "application/zip" }))).toBe(false);
  });

  it("appends text attachments to the prompt with file metadata", () => {
    expect(appendTextAttachmentsToPrompt("Review this", [
      {
        kind: "text",
        filename: "index.html",
        mediaType: "text/html",
        text: "<h1>Hello</h1>",
        truncated: false,
      },
    ])).toContain("Attached file: index.html\nMedia type: text/html\n```html\n<h1>Hello</h1>\n```");
  });
});
