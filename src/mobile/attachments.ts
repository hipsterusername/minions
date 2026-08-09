export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageAttachment {
  kind: "image";
  filename?: string;
  mediaType: ImageMediaType;
  data: string;
}

export interface TextAttachment {
  kind: "text";
  filename: string;
  mediaType: string;
  text: string;
  truncated: boolean;
}

export const ACCEPTED_IMAGE_TYPES: readonly ImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "c",
  "cc",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const TEXT_ATTACHMENT_MEDIA_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/typescript",
  "application/x-javascript",
  "application/x-sh",
  "application/xhtml+xml",
  "application/xml",
]);

export const TEXT_ATTACHMENT_ACCEPT =
  ".txt,.md,.markdown,.mdx,.html,.htm,.css,.js,.jsx,.ts,.tsx,.json,.csv,.xml,.yaml,.yml,.toml,.log,.env,.sh,.py,text/*,application/json,application/xml";

export const MAX_TEXT_ATTACHMENT_CHARS = 200_000;

interface ImageAttachmentReader {
  result: string | ArrayBuffer | null;
  error: DOMException | null;
  onload: FileReader["onload"];
  onerror: FileReader["onerror"];
  readAsDataURL: (blob: Blob) => void;
}

export type ImageAttachmentReaderFactory = () => ImageAttachmentReader;

interface TextAttachmentReader {
  result: string | ArrayBuffer | null;
  error: DOMException | null;
  onload: FileReader["onload"];
  onerror: FileReader["onerror"];
  readAsText: (blob: Blob) => void;
}

export type TextAttachmentReaderFactory = () => TextAttachmentReader;

export function isAcceptedImageType(type: string): type is ImageMediaType {
  return ACCEPTED_IMAGE_TYPES.includes(type as ImageMediaType);
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function isAcceptedTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (TEXT_ATTACHMENT_MEDIA_TYPES.has(file.type)) return true;
  return TEXT_ATTACHMENT_EXTENSIONS.has(extensionOf(file.name));
}

function defaultReaderFactory(): ImageAttachmentReader {
  return new FileReader();
}

function defaultTextReaderFactory(): TextAttachmentReader {
  return new FileReader();
}

export async function fileToImageAttachment(
  file: File,
  readerFactory: ImageAttachmentReaderFactory = defaultReaderFactory,
): Promise<ImageAttachment> {
  if (!isAcceptedImageType(file.type)) {
    throw new Error(`Unsupported image type: ${file.type || "unknown"}`);
  }
  const mediaType = file.type;

  return new Promise((resolve, reject) => {
    const reader = readerFactory();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("FileReader did not return a data URL"));
        return;
      }

      const prefix = `data:${mediaType};base64,`;
      if (!reader.result.startsWith(prefix)) {
        reject(new Error("FileReader returned an unexpected data URL"));
        return;
      }

      resolve({
        kind: "image",
        filename: file.name,
        mediaType,
        data: reader.result.slice(prefix.length),
      });
    };

    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read image"));
    };

    reader.readAsDataURL(file);
  });
}

export async function fileToTextAttachment(
  file: File,
  readerFactory: TextAttachmentReaderFactory = defaultTextReaderFactory,
): Promise<TextAttachment> {
  if (!isAcceptedTextFile(file)) {
    throw new Error(`Unsupported text file: ${file.name || file.type || "unknown"}`);
  }

  return new Promise((resolve, reject) => {
    const reader = readerFactory();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("FileReader did not return text"));
        return;
      }

      const truncated = reader.result.length > MAX_TEXT_ATTACHMENT_CHARS;
      resolve({
        kind: "text",
        filename: file.name || "attachment.txt",
        mediaType: file.type || "text/plain",
        text: truncated ? reader.result.slice(0, MAX_TEXT_ATTACHMENT_CHARS) : reader.result,
        truncated,
      });
    };

    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read text file"));
    };

    reader.readAsText(file);
  });
}

function fenceFor(text: string): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence;
}

function languageFor(filename: string): string {
  switch (extensionOf(filename)) {
    case "css": return "css";
    case "csv": return "csv";
    case "htm":
    case "html": return "html";
    case "js":
    case "jsx":
    case "mjs": return "javascript";
    case "json": return "json";
    case "md":
    case "mdx":
    case "markdown": return "markdown";
    case "py": return "python";
    case "sh": return "sh";
    case "ts":
    case "tsx": return "typescript";
    case "xml": return "xml";
    case "yaml":
    case "yml": return "yaml";
    default: return "";
  }
}

export function appendTextAttachmentsToPrompt(
  prompt: string,
  attachments: readonly TextAttachment[],
): string {
  if (attachments.length === 0) return prompt.trim();

  const blocks = attachments.map((attachment) => {
    const fence = fenceFor(attachment.text);
    const language = languageFor(attachment.filename);
    const truncated = attachment.truncated
      ? `\n\n[File truncated to ${MAX_TEXT_ATTACHMENT_CHARS} characters.]`
      : "";
    return [
      `Attached file: ${attachment.filename}`,
      `Media type: ${attachment.mediaType}`,
      `${fence}${language}`,
      attachment.text,
      `${fence}${truncated}`,
    ].join("\n");
  });

  return [prompt.trim(), ...blocks].filter(Boolean).join("\n\n");
}
